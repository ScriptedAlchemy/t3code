// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Rebuilds what each billed request carried, from local transcripts. Output holds numbers and hashes, never chat text.
// usage: node evals/cache-snip/replay.ts <artifact dir> [days]
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { loadApiCalls, promptTokens, type ApiCall } from "./usageRecords.ts";

export type BlockKind = "tool_output" | "tool_call" | "assistant" | "reasoning" | "user";
export type ToolClass = "read" | "search" | "shell" | "edit" | "mcp" | "agent" | "other";

export interface Block {
  /** Position in the replay's block list. */
  id: number;
  /** Index of the first call whose prompt contains this block. */
  arrival: number;
  /** First call whose prompt no longer contains it, after a real compaction or reset. */
  end: number | null;
  tokens: number;
  /** Raw size before prompt growth pinned `tokens`. Fits the weights in `WEIGHTS`. */
  estimate: number;
  kind: BlockKind;
  toolClass: ToolClass | null;
  /** Responses that quoted something only this block supplied, in order. */
  uses: number[];
  /** User messages that named something only this block supplied. Known before the turn runs. */
  mentions: number[];
  /** Last of `uses`, or arrival. */
  lastUse: number;
  /** Same, also counting plain long words. A looser reading of "used". */
  lastUseLoose: number;
  /** First later call that made this block out of date: same command re-run, or its file edited. */
  supersededAt: number | null;
  /** First later call that read any part of the same file again. Weaker than `supersededAt`. */
  rereadAt: number | null;
  commandKey: string | null;
  /** Hashed paths this block read. Lets the natural experiment spot re-reads across compactions. */
  fileKeys: string[];
  /** Transcript line, joining earlier blind-judge labels. Null where the source has none. */
  line: number | null;
  /** Hash of a user message's text, joining thread-split labels. */
  textKey: string | null;
}

export interface Call {
  ts: number;
  model: string;
  prompt: number;
  read: number;
  miss: number;
  output: number;
  usd: number;
  /** Prompt shrank by over 20% since the previous call. */
  reset: boolean;
}

export interface Replay {
  file: string;
  provider: string;
  calls: Call[];
  blocks: Block[];
  /** Calls that start a real user turn, excluding harness messages that only look like one. */
  turnStarts: number[];
}

// Fitted against reported prompt growth (compose.ts's companion regression): Claude R2 0.99, Codex R2 0.50.
const WEIGHTS: Readonly<Record<string, Readonly<Record<BlockKind, number>>>> = {
  codex: { tool_output: 0.85, tool_call: 1.1, assistant: 1.1, reasoning: 0.25, user: 1 },
  claude: { tool_output: 1.6, tool_call: 1.55, assistant: 1.55, reasoning: 1.4, user: 1.4 },
};
const IMAGE_TOKEN_ESTIMATE = 1500;
const MAX_SCAN_CHARS = 200_000;
const RESET_DROP = 0.8;

const hash = (value: string) =>
  NodeCrypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
export const hashUserText = (text: string) => hash(text.replace(/\s+/g, " ").trim().slice(0, 200));

const CANDIDATE = /[A-Za-z0-9_][A-Za-z0-9_\-./]{3,}/g;
const strictToken = (token: string) =>
  token.length >= 5 && (/[_\-./]/.test(token) || /\d/.test(token) || /[a-z][A-Z]/.test(token));
const looseToken = (token: string) => token.length >= 8 && /^[A-Za-z]+$/.test(token);

function tokensOf(text: string) {
  const strict = new Set<string>();
  const loose = new Set<string>();
  for (const match of text.slice(0, MAX_SCAN_CHARS).matchAll(CANDIDATE)) {
    const token = match[0].replace(/[./\-_]+$/, "");
    if (strictToken(token)) strict.add(token);
    else if (looseToken(token)) loose.add(token.toLowerCase());
  }
  return { strict, loose };
}

/** Local-only text for building a labelled set. Replays themselves never hold chat text. */
export interface TextCapture {
  readonly wanted: ReadonlySet<number>;
  readonly outputs: Map<number, string>;
  readonly calls: Map<number, string>;
  readonly users: { call: number; text: string }[];
  readonly answers: { call: number; text: string }[];
}

interface ToolMeta {
  readonly label?: string;
  readonly toolClass: ToolClass;
  readonly commandKey: string | null;
  readonly reads: readonly string[];
  readonly edits: readonly string[];
}

const READ_COMMAND =
  /\b(?:cat|sed\s+-n|nl|head|tail|less|bat)\b[^|;&\n]*?([\w./~-]+\.[A-Za-z0-9]+)/g;
const PATCH_FILE = /\*\*\* (?:Update|Add|Delete) File: ([^\s"\\]+)/g;
const SEARCH_COMMAND = /(^|[\s;&|(])(rg|grep|find|ls|fd|tree|git\s+(log|grep|show|diff|status))\b/;

/** One classifier per provider shape, fed by the raw command text. */
function classifyCommand(text: string): ToolMeta {
  const reads = [...text.matchAll(READ_COMMAND)].flatMap((match) => match[1] ?? []);
  const edits = [...text.matchAll(PATCH_FILE)].flatMap((match) => match[1] ?? []);
  const toolClass: ToolClass =
    edits.length > 0
      ? "edit"
      : reads.length > 0
        ? "read"
        : SEARCH_COMMAND.test(text)
          ? "search"
          : "shell";
  return {
    label: text.slice(0, 400),
    toolClass,
    commandKey: hash(text.replace(/\s+/g, " ").trim()),
    reads,
    edits,
  };
}

class ReplayBuilder {
  private readonly weights: Readonly<Record<BlockKind, number>>;
  private readonly capture: TextCapture | undefined;
  constructor(weights: Readonly<Record<BlockKind, number>>, capture?: TextCapture) {
    this.weights = weights;
    this.capture = capture;
  }
  readonly calls: Call[] = [];
  readonly blocks: Block[] = [];
  readonly turnStarts: number[] = [];
  private live: Block[] = [];
  private pendingArrivals: Block[] = [];
  private strictProvider = new Map<string, Block>();
  private looseProvider = new Map<string, Block>();
  private lastByCommand = new Map<string, Block>();
  private readersByFile = new Map<string, Block[]>();
  /** Codex logs a response's usage before its tool output and again after, so inputs in between belong to the next call. */
  inputOffset = 0;
  /** Transcript line being read. */
  line: number | null = null;

  private add(kind: BlockKind, estimate: number, arrival: number, meta: ToolMeta | null): Block {
    const block: Block = {
      id: this.blocks.length,
      arrival,
      end: null,
      tokens: 0,
      estimate,
      kind,
      toolClass: meta?.toolClass ?? null,
      uses: [],
      mentions: [],
      lastUse: arrival,
      lastUseLoose: arrival,
      supersededAt: null,
      rereadAt: null,
      commandKey: meta?.commandKey ?? null,
      fileKeys: (meta?.reads ?? []).map(hash),
      line: this.line,
      textKey: null,
    };
    this.blocks.push(block);
    this.pendingArrivals.push(block);
    return block;
  }

  markTurnStart() {
    this.turnStarts.push(this.calls.length + this.inputOffset);
  }

  userMessage(text: string, images = 0) {
    const block = this.add(
      "user",
      text.length / 4 + images * IMAGE_TOKEN_ESTIMATE,
      this.calls.length + this.inputOffset,
      null,
    );
    block.textKey = hashUserText(text);
    this.capture?.users.push({ call: block.arrival, text });
    const { strict } = tokensOf(text);
    const mentioned = new Set<Block>();
    for (const token of strict) {
      const provider = this.strictProvider.get(token);
      if (provider !== undefined) mentioned.add(provider);
    }
    for (const provider of mentioned) provider.mentions.push(block.arrival);
  }

  toolOutput(text: string, images: number, meta: ToolMeta | null) {
    const block = this.add(
      "tool_output",
      text.length / 4 + images * IMAGE_TOKEN_ESTIMATE,
      this.calls.length + this.inputOffset,
      meta,
    );
    if (this.capture?.wanted.has(block.id) === true) {
      this.capture.outputs.set(block.id, text);
      this.capture.calls.set(block.id, meta?.label ?? "");
    }
    const { strict, loose } = tokensOf(text);
    for (const token of strict) this.strictProvider.set(token, block);
    for (const token of loose) this.looseProvider.set(token, block);
    if (meta !== null) {
      if (meta.commandKey !== null) {
        const earlier = this.lastByCommand.get(meta.commandKey);
        if (earlier !== undefined && earlier.supersededAt === null) {
          earlier.supersededAt = block.arrival;
        }
        this.lastByCommand.set(meta.commandKey, block);
      }
      for (const file of meta.reads) {
        const readers = this.readersByFile.get(file) ?? [];
        for (const reader of readers) reader.rereadAt ??= block.arrival;
        readers.push(block);
        this.readersByFile.set(file, readers);
      }
      for (const file of meta.edits) {
        for (const reader of this.readersByFile.get(file) ?? []) {
          if (reader.supersededAt === null) reader.supersededAt = block.arrival;
        }
        this.readersByFile.delete(file);
      }
    }
  }

  /** A model emission: enters the prompt after `response`, and proves earlier blocks were used at `response`. */
  emission(
    kind: Exclude<BlockKind, "tool_output" | "user">,
    text: string,
    estimate: number,
    response: number,
  ) {
    this.add(kind, estimate, response + 1, null);
    if (kind === "assistant") this.capture?.answers.push({ call: response, text });
    const { strict, loose } = tokensOf(text);
    const strictHits = new Map<Block, { count: number; long: boolean }>();
    for (const token of strict) {
      const provider = this.strictProvider.get(token);
      if (provider === undefined) continue;
      const hit = strictHits.get(provider) ?? { count: 0, long: false };
      hit.count += 1;
      hit.long ||= token.length >= 12;
      strictHits.set(provider, hit);
    }
    for (const [provider, hit] of strictHits) {
      if (hit.count >= 2 || hit.long) {
        if (provider.uses.at(-1) !== response) provider.uses.push(response);
        provider.lastUse = Math.max(provider.lastUse, response);
        provider.lastUseLoose = Math.max(provider.lastUseLoose, response);
      }
    }
    const looseHits = new Map<Block, number>();
    for (const token of loose) {
      const provider = this.looseProvider.get(token);
      if (provider !== undefined) looseHits.set(provider, (looseHits.get(provider) ?? 0) + 1);
    }
    for (const [provider, count] of looseHits) {
      if (count >= 2) provider.lastUseLoose = Math.max(provider.lastUseLoose, response);
    }
  }

  apiCall(call: ApiCall, usd: number) {
    this.inputOffset = 0;
    const index = this.calls.length;
    const prompt = promptTokens(call);
    const previous = this.calls[index - 1];
    const reset = previous !== undefined && prompt < previous.prompt * RESET_DROP;
    if (reset) {
      for (const block of this.live) block.end = index;
      this.live = [];
      this.strictProvider.clear();
      this.looseProvider.clear();
      this.lastByCommand.clear();
      this.readersByFile.clear();
    }

    const arriving = this.pendingArrivals.filter((block) => block.arrival <= index);
    this.pendingArrivals = this.pendingArrivals.filter((block) => block.arrival > index);
    const weighted = (block: Block) => block.estimate * this.weights[block.kind];
    const estimated = arriving.reduce((sum, block) => sum + weighted(block), 0);
    const growth = previous === undefined || reset ? prompt : Math.max(0, prompt - previous.prompt);
    // Never attribute more than was billed. Growth left over stays unattributed framing, which no snip can remove.
    const scale = estimated > growth && estimated > 0 ? growth / estimated : 1;
    for (const block of arriving) {
      block.tokens = Math.round(weighted(block) * scale);
      this.live.push(block);
    }

    this.calls.push({
      ts: call.timestampMs,
      model: call.model,
      prompt,
      read: call.cacheRead,
      miss: call.uncached + call.cacheWrite,
      output: call.output,
      usd,
      reset,
    });
  }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function contentText(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: "", images: 0 };
  let text = "";
  let images = 0;
  for (const part of content) {
    if (!isObject(part)) continue;
    const type = part["type"];
    if (type === "input_image" || type === "image" || type === "output_image") images += 1;
    else if (typeof part["text"] === "string") text += `${part["text"]}\n`;
  }
  return { text, images };
}

async function* lines(file: string) {
  const reader = NodeReadline.createInterface({
    input: NodeFS.createReadStream(file),
    crlfDelay: Infinity,
  });
  for await (const line of reader) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isObject(parsed)) yield parsed;
    } catch {
      // Unterminated tail of a live session.
    }
  }
}

function callQueue(calls: readonly ApiCall[]) {
  const byTimestamp = new Map<number, ApiCall[]>();
  for (const call of calls) {
    const list = byTimestamp.get(call.timestampMs) ?? [];
    list.push(call);
    byTimestamp.set(call.timestampMs, list);
  }
  return (timestampMs: number) => byTimestamp.get(timestampMs)?.shift();
}

export async function readCodex(
  file: string,
  calls: readonly ApiCall[],
  priceOf: (call: ApiCall) => number,
  capture?: TextCapture,
) {
  const builder = new ReplayBuilder(WEIGHTS["codex"]!, capture);
  const take = callQueue(calls);
  const metaByCall = new Map<string, ToolMeta>();
  let lineNumber = 0;
  for await (const line of lines(file)) {
    lineNumber += 1;
    builder.line = lineNumber;
    const type = line["type"];
    const payload = isObject(line["payload"]) ? line["payload"] : {};
    const inner = payload["type"];
    const timestamp =
      typeof line["timestamp"] === "string" ? Date.parse(line["timestamp"]) : Number.NaN;
    if (type === "token_usage_record" || (type === "event_msg" && inner === "token_count")) {
      const call = take(timestamp);
      if (call !== undefined) builder.apiCall(call, priceOf(call));
      else if (type === "token_usage_record") builder.inputOffset = 1;
      continue;
    }
    if (type === "event_msg" && inner === "task_started") builder.markTurnStart();
    if (type !== "response_item") continue;
    const response = builder.calls.length;
    if (inner === "message") {
      const { text, images } = contentText(payload["content"]);
      if (payload["role"] === "assistant") {
        builder.emission("assistant", text, text.length / 4, response);
      } else if (payload["role"] === "user") {
        builder.userMessage(text, images);
      }
    } else if (inner === "agent_message") {
      const { text } = contentText(payload["content"]);
      builder.userMessage(text);
    } else if (inner === "reasoning") {
      const encrypted = payload["encrypted_content"];
      const { text } = contentText(payload["summary"]);
      builder.emission(
        "reasoning",
        text,
        (typeof encrypted === "string" ? encrypted.length : 0) * 0.2,
        response,
      );
    } else if (inner === "custom_tool_call" || inner === "function_call") {
      const raw = inner === "custom_tool_call" ? payload["input"] : payload["arguments"];
      const text = typeof raw === "string" ? raw : "";
      const name = typeof payload["name"] === "string" ? payload["name"] : "";
      const namespace = typeof payload["namespace"] === "string" ? payload["namespace"] : "";
      const command = classifyCommand(text);
      const meta: ToolMeta =
        namespace.startsWith("mcp") || name.startsWith("mcp__")
          ? { ...command, toolClass: "mcp" }
          : name === "spawn_agent" || name === "wait_agent"
            ? { ...command, toolClass: "agent" }
            : command;
      if (typeof payload["call_id"] === "string") metaByCall.set(payload["call_id"], meta);
      builder.emission("tool_call", text, text.length / 4, response);
    } else if (inner === "custom_tool_call_output" || inner === "function_call_output") {
      const callId = payload["call_id"];
      const { text, images } = contentText(payload["output"]);
      builder.toolOutput(
        text,
        images,
        (typeof callId === "string" ? metaByCall.get(callId) : undefined) ?? null,
      );
    }
  }
  return builder;
}

const CLAUDE_READ_TOOLS = new Set(["Read"]);
const CLAUDE_SEARCH_TOOLS = new Set(["Grep", "Glob", "LS", "ToolSearch"]);
const CLAUDE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function classifyClaudeTool(name: string, input: Json): ToolMeta {
  return {
    ...claudeToolMeta(name, input),
    label: `${name} ${JSON.stringify(input).slice(0, 380)}`,
  };
}

function claudeToolMeta(name: string, input: Json): ToolMeta {
  const key = hash(`${name}:${JSON.stringify(input)}`);
  const path = typeof input["file_path"] === "string" ? input["file_path"] : null;
  if (CLAUDE_READ_TOOLS.has(name)) {
    return { toolClass: "read", commandKey: key, reads: path === null ? [] : [path], edits: [] };
  }
  if (CLAUDE_EDIT_TOOLS.has(name)) {
    return { toolClass: "edit", commandKey: key, reads: [], edits: path === null ? [] : [path] };
  }
  if (CLAUDE_SEARCH_TOOLS.has(name)) {
    return { toolClass: "search", commandKey: key, reads: [], edits: [] };
  }
  if (name === "Bash" && typeof input["command"] === "string") {
    return classifyCommand(input["command"]);
  }
  if (name === "Agent" || name === "Task") {
    return { toolClass: "agent", commandKey: key, reads: [], edits: [] };
  }
  return {
    toolClass: name.startsWith("mcp__") ? "mcp" : "other",
    commandKey: key,
    reads: [],
    edits: [],
  };
}

export async function readClaude(
  file: string,
  calls: readonly ApiCall[],
  priceOf: (call: ApiCall) => number,
  capture?: TextCapture,
) {
  const builder = new ReplayBuilder(WEIGHTS["claude"]!, capture);
  const byKey = new Map(calls.map((call) => [call.dedupeKey, call]));
  const metaByUse = new Map<string, ToolMeta>();
  for await (const line of lines(file)) {
    const message = line["message"];
    if (!isObject(message)) continue;
    const content = message["content"];
    if (line["type"] === "user") {
      if (line["isMeta"] === true) continue;
      if (typeof content === "string") {
        builder.markTurnStart();
        builder.userMessage(content);
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!isObject(part)) continue;
        if (part["type"] === "tool_result") {
          const { text, images } = contentText(part["content"]);
          const useId = part["tool_use_id"];
          builder.toolOutput(
            text,
            images,
            (typeof useId === "string" ? metaByUse.get(useId) : undefined) ?? null,
          );
        } else if (part["type"] === "text" && typeof part["text"] === "string") {
          builder.markTurnStart();
          builder.userMessage(part["text"]);
        }
      }
    } else if (line["type"] === "assistant") {
      const key = `${String(message["id"])}:${String(line["requestId"])}`;
      const call = byKey.get(key);
      if (call !== undefined) {
        builder.apiCall(call, priceOf(call));
        byKey.delete(key);
      }
      if (!Array.isArray(content)) continue;
      const response = Math.max(0, builder.calls.length - 1);
      for (const part of content) {
        if (!isObject(part)) continue;
        if (part["type"] === "text" && typeof part["text"] === "string") {
          builder.emission("assistant", part["text"], part["text"].length / 4, response);
        } else if (part["type"] === "thinking") {
          const thinking = typeof part["thinking"] === "string" ? part["thinking"] : "";
          const signature = typeof part["signature"] === "string" ? part["signature"] : "";
          builder.emission(
            "reasoning",
            thinking,
            Math.max(thinking.length / 4, signature.length * 0.2),
            response,
          );
        } else if (part["type"] === "tool_use") {
          const input = isObject(part["input"]) ? part["input"] : {};
          const name = typeof part["name"] === "string" ? part["name"] : "";
          if (typeof part["id"] === "string") {
            metaByUse.set(part["id"], classifyClaudeTool(name, input));
          }
          const text = JSON.stringify(input);
          builder.emission("tool_call", text, text.length / 4, response);
        }
      }
    }
  }
  return builder;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined) throw new Error("usage: replay.ts <artifact dir> [days]");
  const days = Number(process.argv[3] ?? 30);
  const { loadRates, price } = await import("./usageRecords.ts");
  const rates = loadRates(NodePath.join(dir, "usage-model-rates.json"));
  const all = loadApiCalls(NodePath.join(dir, "usage-scan-cache-v11.json"));
  const latest = Math.max(...all.map((call) => call.timestampMs));
  const cutoff = latest - days * 86_400_000;
  const byFile = new Map<string, ApiCall[]>();
  for (const call of all) {
    const list = byFile.get(call.file) ?? [];
    list.push(call);
    byFile.set(call.file, list);
  }
  const outDir = NodePath.join(dir, "replay");
  NodeFS.mkdirSync(outDir, { recursive: true });
  let written = 0;
  let matched = 0;
  let expected = 0;
  let missingFiles = 0;
  for (const [file, calls] of byFile) {
    if (!calls.some((call) => call.timestampMs >= cutoff)) continue;
    const provider = calls[0]!.provider;
    if (provider !== "codex" && provider !== "claude") continue;
    expected += calls.length;
    const priceOf = (call: ApiCall) => price(rates, call).costUsd;
    let builder: ReplayBuilder;
    try {
      builder =
        provider === "codex"
          ? await readCodex(file, calls, priceOf)
          : await readClaude(file, calls, priceOf);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missingFiles += 1;
      continue;
    }
    matched += builder.calls.length;
    const replay: Replay = {
      file,
      provider,
      calls: builder.calls,
      blocks: builder.blocks,
      turnStarts: builder.turnStarts,
    };
    NodeFS.writeFileSync(NodePath.join(outDir, `${hash(file)}.json`), JSON.stringify(replay));
    written += 1;
  }
  console.log(
    `replays ${written}, missing transcripts ${missingFiles}, calls aligned ${matched} of ${expected} (${((matched / Math.max(expected, 1)) * 100).toFixed(1)}%)`,
  );
}
