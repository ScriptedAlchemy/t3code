import type {
  ForgeCommand,
  ForgeCommandTarget,
  ForgeReadIntent,
} from "@t3tools/source-control-core/shared/definition";

// Every `gh pr view --json` field pull_request_status reports.
const STATUS_FIELDS = new Set([
  "number",
  "url",
  "title",
  "state",
  "isDraft",
  "headRefName",
  "baseRefName",
  "headRefOid",
  "mergeable",
  "mergeStateStatus",
  "reviewDecision",
  "statusCheckRollup",
]);
const FEEDBACK_FIELDS = new Set(["comments", "reviews", "latestReviews"]);

const PR_WRITES = new Set([
  "create",
  "merge",
  "close",
  "edit",
  "comment",
  "review",
  "ready",
  "reopen",
  "lock",
  "unlock",
  "update-branch",
]);
const RUN_WRITES = new Set(["rerun", "cancel", "delete"]);
const WORKFLOW_WRITES = new Set(["run", "enable", "disable"]);

// Flags that take the next word as their value, so positional arguments can be told apart.
const VALUE_FLAGS = new Set([
  "-R",
  "--repo",
  "--hostname",
  "--json",
  "-q",
  "--jq",
  "-t",
  "--template",
  "-i",
  "--interval",
  "-j",
  "--job",
  "-a",
  "--attempt",
  "-L",
  "--limit",
  "-b",
  "--branch",
  "-w",
  "--workflow",
  "-s",
  "--status",
  "-u",
  "--user",
  "-e",
  "--event",
  "-c",
  "--commit",
  "-B",
  "--base",
  "-H",
  "--head",
]);
// `gh api` reads `-i` as `--include` and `-H` as a header; both still take or skip a value as listed.
const API_VALUE_FLAGS = new Set([
  "--hostname",
  "-X",
  "--method",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "-H",
  "--header",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--cache",
  "-p",
  "--preview",
]);
const API_BODY_FLAGS = new Set(["-f", "--raw-field", "-F", "--field", "--input"]);

const REPOSITORY = /([^/\s]+\/[^/\s]+)\/?$/u;
const NUMBER = /^\d+$/u;
const URL = /^https?:\/\//u;

interface ParsedArgs {
  readonly flags: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly positionals: ReadonlyArray<string>;
}

function parseArgs(words: ReadonlyArray<string>, valueFlags: ReadonlySet<string>): ParsedArgs {
  const flags = new Map<string, Array<string>>();
  const positionals: Array<string> = [];
  const add = (flag: string, value: string) => flags.set(flag, [...(flags.get(flag) ?? []), value]);
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? "";
    if (word === "--") {
      positionals.push(...words.slice(index + 1));
      break;
    }
    if (!word.startsWith("-") || word === "-") {
      positionals.push(word);
      continue;
    }
    const equals = word.startsWith("--") ? word.indexOf("=") : -1;
    if (equals !== -1) {
      add(word.slice(0, equals), word.slice(equals + 1));
    } else if (!word.startsWith("--") && word.length > 2 && valueFlags.has(word.slice(0, 2))) {
      add(word.slice(0, 2), word.slice(2).replace(/^=/u, ""));
    } else if (valueFlags.has(word)) {
      add(word, words[++index] ?? "");
    } else {
      add(word, "");
    }
  }
  return { flags, positionals };
}

const has = (args: ParsedArgs, ...flags: ReadonlyArray<string>) =>
  flags.some((flag) => args.flags.has(flag));
const value = (args: ParsedArgs, ...flags: ReadonlyArray<string>) =>
  flags.flatMap((flag) => args.flags.get(flag) ?? []).at(-1);

/** `-R acme/app`, `-R github.com/acme/app` or a repository URL, as `owner/repo`. */
function repositoryOf(args: ParsedArgs): ForgeCommandTarget {
  const repo = value(args, "-R", "--repo");
  const match = repo === undefined ? null : REPOSITORY.exec(repo.replace(/^https?:\/\//u, ""));
  return match === null || repo?.includes("{") ? {} : { repository: match[1]!.toLowerCase() };
}

function pullRequestTarget(args: ParsedArgs): ForgeCommandTarget | null {
  const target = repositoryOf(args);
  const selector = args.positionals[0];
  if (selector === undefined) return target;
  if (NUMBER.test(selector)) return { ...target, number: Number(selector) };
  // A branch name selects by head ref; only a number or URL names the pull request itself.
  return URL.test(selector) ? { url: selector } : null;
}

const read = (intent: ForgeReadIntent, target: ForgeCommandTarget): ForgeCommand => ({
  kind: "read",
  intent,
  target,
});
const WRITE: ForgeCommand = { kind: "write" };
const POLL: ForgeCommand = { kind: "poll" };
const OTHER: ForgeCommand = { kind: "other" };

function classifyPullRequest(subcommand: string, rest: ReadonlyArray<string>): ForgeCommand {
  if (PR_WRITES.has(subcommand)) return WRITE;
  const args = parseArgs(rest, VALUE_FLAGS);
  if (subcommand === "checks" && has(args, "--watch")) return POLL;
  const target = pullRequestTarget(args);
  if (target === null) return OTHER;
  if (subcommand === "checks") return read("status", target);
  if (subcommand !== "view" || has(args, "--web", "-w")) return OTHER;
  if (has(args, "--comments", "-c")) return read("feedback", target);
  const fields = (args.flags.get("--json") ?? []).flatMap((list) => list.split(","));
  if (fields.length === 0) return OTHER;
  if (fields.every((field) => STATUS_FIELDS.has(field))) {
    return read("status", target);
  }
  return fields.every((field) => FEEDBACK_FIELDS.has(field)) ? read("feedback", target) : OTHER;
}

function classifyRun(subcommand: string, rest: ReadonlyArray<string>): ForgeCommand {
  if (subcommand === "watch") return POLL;
  if (RUN_WRITES.has(subcommand)) return WRITE;
  if (subcommand !== "view") return OTHER;
  const args = parseArgs(rest, VALUE_FLAGS);
  return has(args, "--log", "--log-failed") ? read("failures", repositoryOf(args)) : OTHER;
}

const JOB_ROUTE = /^repos\/([^/]+\/[^/]+)\/actions\/jobs\/[^/]+(?:\/logs)?$/u;
const ANNOTATIONS_ROUTE = /^repos\/([^/]+\/[^/]+)\/check-runs\/[^/]+\/annotations$/u;
const FEEDBACK_ROUTE =
  /^repos\/([^/]+\/[^/]+)\/(?:pulls\/([^/]+)\/(?:comments|reviews)|issues\/([^/]+)\/comments)$/u;

function routeTarget(repository: string, number?: string): ForgeCommandTarget {
  const target: ForgeCommandTarget = repository.includes("{")
    ? {}
    : { repository: repository.toLowerCase() };
  return number !== undefined && NUMBER.test(number)
    ? { ...target, number: Number(number) }
    : target;
}

function classifyApi(rest: ReadonlyArray<string>): ForgeCommand {
  const args = parseArgs(rest, API_VALUE_FLAGS);
  const method =
    value(args, "-X", "--method")?.toUpperCase() ??
    // gh api turns a body flag into a POST unless the method says otherwise.
    (has(args, ...API_BODY_FLAGS) ? "POST" : "GET");
  if (method !== "GET") return WRITE;
  const path = (args.positionals[0] ?? "")
    .replace(/^https?:\/\/[^/]+\//u, "")
    .replace(/^\/+/u, "")
    .replace(/[?#][\s\S]*$/u, "");
  const job = JOB_ROUTE.exec(path) ?? ANNOTATIONS_ROUTE.exec(path);
  if (job !== null) return read("failures", routeTarget(job[1]!));
  const feedback = FEEDBACK_ROUTE.exec(path);
  if (feedback !== null)
    return read("feedback", routeTarget(feedback[1]!, feedback[2] ?? feedback[3]));
  return OTHER;
}

/** What a `gh` command does, or null when the words run another program. */
export function classifyGhCommand(words: ReadonlyArray<string>): ForgeCommand | null {
  if (words[0] !== "gh") return null;
  let start = 1;
  while (start < words.length) {
    const flag = words[start] ?? "";
    if (flag === "-R" || flag === "--repo" || flag === "--hostname") start += 2;
    else if (/^(?:-R.|--(?:repo|hostname)=)/u.test(flag)) start++;
    else break;
  }
  const [group = "", subcommand = "", ...tail] = words.slice(start);
  const rest = [...words.slice(1, start), ...tail];
  switch (group) {
    case "pr":
      return classifyPullRequest(subcommand, rest);
    case "run":
      return classifyRun(subcommand, rest);
    case "workflow":
      return WORKFLOW_WRITES.has(subcommand) ? WRITE : OTHER;
    case "api":
      return classifyApi(subcommand === "" ? rest : [subcommand, ...rest]);
    default:
      return OTHER;
  }
}
