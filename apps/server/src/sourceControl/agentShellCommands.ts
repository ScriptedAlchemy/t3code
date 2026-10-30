import type { SourceControlProviderKind } from "@t3tools/contracts";
import type { ForgeCommand } from "@t3tools/source-control-core/shared/definition";

import { sourceControlDefinitions } from "./sourceControlDefinitions.ts";

// Where a shell starts a command, past `NAME=value` assignments and wrappers like `timeout 60`.
// A command anywhere else, as in `echo "gh pr create"`, is text, not a command that runs.
export const COMMAND_START =
  "(?:^|[;&|({`\\n]|\\b(?:do|then|else)\\s)\\s*(?:(?:\\w+=\\S*|env|time|nohup|timeout\\s+\\S+)\\s+)*";
export const COMMAND_SEPARATOR = /&&|\|\||[;|\n]/u;

// Codex runs each command as `/bin/zsh -lc <script>`, quoting the script in pieces such as
// `"a "'`b`'" c"`.
const SHELL_WRAPPER = /^\s*(?:\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+(?=["'])([\s\S]*)$/u;
const SHELL_WORD_PIECE = /"((?:\\[\s\S]|[^"\\])*)"|'([^']*)'|\\([\s\S])|(\S)/gu;
// Heredoc bodies, quoted strings and comments are text a command carries, not commands it runs.
const HEREDOC_BODY =
  /<<-?[ \t]*(['"]?)(\w+)\1[^\n]*\n(?:(?:[\s\S]*?\n)?[ \t]*\2[ \t]*(?=\n|$)|[\s\S]*$)/gu;
const QUOTED_OR_COMMENT = /'[^']*'|"(?:\\[\s\S]|[^"\\])*"|(?<=^|[\s;&|(])#[^\n]*/gmu;

/** The script a shell input runs, unwrapped from Codex's `sh -lc`. */
export function shellScript(input: string): string {
  const [, wrapped] = SHELL_WRAPPER.exec(input) ?? [];
  return wrapped === undefined
    ? input
    : Array.from(
        wrapped.matchAll(SHELL_WORD_PIECE),
        ([, double, single, escaped, bare]) =>
          double?.replace(/\\(["\\$`])/gu, "$1") ?? single ?? escaped ?? bare,
      ).join("");
}

function splitShell(script: string, subshells: boolean): ReadonlyArray<string> {
  const segments: Array<string> = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < script.length; index++) {
    const char = script[index] ?? "";
    if (quote !== null) {
      current += char;
      if (char === "\\" && quote === '"') current += script[++index] ?? "";
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    if (char === "\\") {
      current += char + (script[++index] ?? "");
      continue;
    }
    const pair = script.slice(index, index + 2);
    if (
      pair === "&&" ||
      pair === "||" ||
      char === ";" ||
      char === "|" ||
      char === "\n" ||
      (subshells && (char === "(" || char === ")" || char === "`"))
    ) {
      segments.push(current);
      current = "";
      if (pair === "&&" || pair === "||") index++;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

/** A script split at command separators that sit outside quotes. */
export const shellSegments = (script: string): ReadonlyArray<string> => splitShell(script, false);

/** The commands a script runs, without the text it carries. */
export const shellCode = (script: string) =>
  script.replace(HEREDOC_BODY, "<<").replace(QUOTED_OR_COMMENT, "''");

/** One segment's words with quotes resolved, stopping at a comment. */
function shellWords(segment: string): Array<string> {
  const words: Array<string> = [];
  let current: string | null = null;
  let quote: string | null = null;
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index] ?? "";
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"') current = (current ?? "") + (segment[++index] ?? "");
      else current = (current ?? "") + char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current ??= "";
    } else if (char === "\\") {
      current = (current ?? "") + (segment[++index] ?? "");
    } else if (/\s/u.test(char)) {
      if (current !== null) words.push(current);
      current = null;
    } else if (char === "#" && current === null) {
      break;
    } else {
      current = (current ?? "") + char;
    }
  }
  if (current !== null) words.push(current);
  return words;
}

export interface AgentShellCommand {
  /** The program and its arguments, after assignments and wrappers such as `timeout 60`. */
  readonly words: ReadonlyArray<string>;
  /** `NAME=value` assignments that prefixed the command, including those after `env`. */
  readonly assignments: ReadonlyMap<string, string>;
  /** Runs more than once: under `watch`, inside an `until`/`while` loop, or a `for` loop. */
  readonly repeats: boolean;
  readonly bypassCommand: string;
}

const ASSIGNMENT = /^([A-Za-z_]\w*)=([\s\S]*)$/u;
const REDIRECTION = /^\d*(?:>>?|<<?|&>)(?:&\d+|\S*)$/u;
const REDIRECTION_OPERATOR = /^\d*(?:>>?|<|&>)$/u;
const LOOP_KEYWORDS = new Set(["until", "while", "for"]);
const DROPPED_KEYWORDS = new Set(["do", "then", "else", "if", "elif", "!", "{", "}"]);
const PLAIN_WRAPPERS = new Set(["env", "time", "nohup", "exec", "command", "builtin"]);

function stripRedirections(words: ReadonlyArray<string>): Array<string> {
  const kept: Array<string> = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? "";
    if (REDIRECTION_OPERATOR.test(word)) index++;
    else if (!REDIRECTION.test(word)) kept.push(word);
  }
  return kept;
}

/** The commands a shell input runs, in order. Text inside quotes and heredocs is not a command. */
export function agentShellCommands(input: string): ReadonlyArray<AgentShellCommand> {
  const script = shellScript(input).replace(HEREDOC_BODY, "<<");
  const segments = splitShell(script, true);
  const commands: Array<AgentShellCommand> = [];
  let loopDepth = 0;
  let offset = 0;
  for (const source of segments) {
    const start = script.indexOf(source, offset);
    offset = start + source.length;
    const segment = stripRedirections(shellWords(source));
    const assignments = new Map<string, string>();
    let watches = false;
    let index = 0;
    while (index < segment.length) {
      const word = segment[index] ?? "";
      if (word === "done") {
        loopDepth = Math.max(0, loopDepth - 1);
        index++;
      } else if (LOOP_KEYWORDS.has(word)) {
        loopDepth++;
        index++;
      } else if (DROPPED_KEYWORDS.has(word) || PLAIN_WRAPPERS.has(word)) {
        index++;
      } else if (ASSIGNMENT.test(word)) {
        const [, name = "", value = ""] = ASSIGNMENT.exec(word) ?? [];
        assignments.set(name, value);
        index++;
      } else if (word === "timeout" || word === "watch") {
        watches ||= word === "watch";
        index++;
        // Flags, then `timeout`'s duration; `watch -n 5` takes its interval the same way.
        while (index < segment.length && (segment[index] ?? "").startsWith("-")) {
          index += /^-[a-zA-Z]$/u.test(segment[index] ?? "") ? 2 : 1;
        }
        if (word === "timeout") index++;
      } else break;
    }
    const words = segment.slice(index);
    if (words.length === 0) continue;
    const program = words[0] ?? "";
    commands.push({
      words: [program.slice(program.lastIndexOf("/") + 1), ...words.slice(1)],
      assignments,
      repeats: watches || loopDepth > 0,
      bypassCommand: `${script.slice(0, start)}${source.replace(/^(\s*(?:(?:if|elif|then|else|do|!)\s+)*)/u, `$1${GH_DIRECT_ENV}=1 `)}${script.slice(offset)}`,
    });
  }
  return commands;
}

export const GH_DIRECT_ENV = "T3_GH_DIRECT";

export interface AgentForgeCommand {
  readonly forge: SourceControlProviderKind;
  readonly command: ForgeCommand;
  /** Prefixed `T3_GH_DIRECT=1`, which asks T3 to let the command run as typed. */
  readonly bypass: boolean;
  readonly bypassCommand: string;
}

/** The forge CLI commands a shell input runs. A read that repeats is a poll. */
export function classifyAgentShellCommands(input: string): ReadonlyArray<AgentForgeCommand> {
  return agentShellCommands(input).flatMap((shellCommand) => {
    for (const definition of sourceControlDefinitions.definitions) {
      const command = definition.classifyCommand?.(shellCommand.words) ?? null;
      if (command === null) continue;
      return [
        {
          forge: definition.kind,
          command: command.kind === "read" && shellCommand.repeats ? { kind: "poll" } : command,
          bypass: shellCommand.assignments.get(GH_DIRECT_ENV) === "1",
          bypassCommand: shellCommand.bypassCommand,
        },
      ];
    }
    return [];
  });
}
