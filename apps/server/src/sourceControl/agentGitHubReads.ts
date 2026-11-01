import type {
  ForgeCommand,
  ForgeCommandTarget,
  ForgeReadIntent,
} from "@t3tools/source-control-core/shared/definition";
import { definition as gitHubDefinition } from "@t3tools/source-control-github/shared/definition";

import { classifyAgentShellCommands } from "./agentShellCommands.ts";

/** The T3 MCP tool that answers each read intent; a new intent without a tool fails to compile. */
export const PULL_REQUEST_READ_TOOLS = {
  status: "pull_request_status",
  failures: "pull_request_failures",
  feedback: "pull_request_feedback",
} as const satisfies Record<ForgeReadIntent, string>;

/** The tools' input for a command's target; empty when the command meant the current branch's PR. */
export function pullRequestReadArguments(target: ForgeCommandTarget) {
  if (target.url !== undefined) return { pullRequests: [{ url: target.url }] };
  if (target.number === undefined) return {};
  return {
    pullRequests: [
      {
        ...(target.repository === undefined ? {} : { repository: target.repository }),
        number: target.number,
      },
    ],
  };
}

export type GitHubCommandDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

export const POLL_DENIED_REASON =
  "Do not poll GitHub from a shell. A parent calls watch_pull_request and ends its turn; a subagent reads pull_request_status once and reports.";

/**
 * Whether an agent's shell command may run. Reads a T3 tool answers are refused with the exact call
 * to make instead, polls are refused outright, and everything else runs as typed.
 */
export function decideGitHubCommand(command: string): GitHubCommandDecision {
  const commands = classifyAgentShellCommands(command).filter(({ forge }) => forge === "github");
  if (commands.some(({ command: { kind } }) => kind === "poll")) {
    return { allow: false, reason: POLL_DENIED_REASON };
  }
  for (const { command: forgeCommand, bypass, bypassCommand } of commands) {
    if (forgeCommand.kind !== "read" || bypass) continue;
    return denyRead(forgeCommand, bypassCommand);
  }
  return { allow: true };
}

function denyRead(
  command: Extract<ForgeCommand, { kind: "read" }>,
  bypassCommand: string,
): GitHubCommandDecision {
  const tool = PULL_REQUEST_READ_TOOLS[command.intent];
  const args = JSON.stringify(pullRequestReadArguments(command.target));
  const bypassHint = `rerun as \`${bypassCommand.trim()}\`.`;
  const reason =
    command.intent === "failures"
      ? `T3 reads why a PR's checks failed. Call ${tool} with ${args} (load it with ToolSearch if it is deferred). It answers the failing checks of this thread's PR or the PR you name.${command.target.repository === undefined ? "" : ` Your command reads ${command.target.repository}.`} If this run or job belongs to another PR, ${bypassHint}`
      : `T3 already reads this. Call ${tool} with ${args} (load it with ToolSearch if it is deferred). If it can't answer what you need, ${bypassHint}`;
  return { allow: false, reason };
}

/** The PATH launcher receives already-parsed argv; never reinterpret an argument as shell code. */
export function decideGitHubArguments(
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = {},
): GitHubCommandDecision {
  if (environment.GH_HOST || environment.GH_REPO) return { allow: true };
  const command = gitHubDefinition.classifyCommand?.(["gh", ...args]);
  if (command?.kind === "poll") return { allow: false, reason: POLL_DENIED_REASON };
  if (command?.kind !== "read" || environment.T3_GH_DIRECT === "1") return { allow: true };
  const quote = (arg: string) =>
    /^[\w./:=,@+-]+$/u.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`;
  return denyRead(command, `T3_GH_DIRECT=1 gh ${args.map(quote).join(" ")}`);
}
