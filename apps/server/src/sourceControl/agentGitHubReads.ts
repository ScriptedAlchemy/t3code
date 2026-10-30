import type {
  ForgeCommandTarget,
  ForgeReadIntent,
} from "@t3tools/source-control-core/shared/definition";

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
 * Whether a Claude Bash command may run. Reads a T3 tool answers are refused with the exact call
 * to make instead, polls are refused outright, and everything else runs as typed.
 */
export function decideGitHubCommand(command: string): GitHubCommandDecision {
  const commands = classifyAgentShellCommands(command).filter(({ forge }) => forge === "github");
  if (commands.some(({ command: { kind } }) => kind === "poll")) {
    return { allow: false, reason: POLL_DENIED_REASON };
  }
  for (const { command: forgeCommand, bypass, bypassCommand } of commands) {
    if (forgeCommand.kind !== "read" || bypass) continue;
    const tool = PULL_REQUEST_READ_TOOLS[forgeCommand.intent];
    const args = JSON.stringify(pullRequestReadArguments(forgeCommand.target));
    const introduction =
      forgeCommand.intent === "failures"
        ? "Read PR check failures through T3."
        : "T3 already reads this.";
    const scope =
      forgeCommand.intent === "failures"
        ? `This tool answers the failing checks of the thread's or a named PR.${forgeCommand.target.repository === undefined ? "" : ` The requested repository is ${forgeCommand.target.repository}.`} If this run or job is not one of those, rerun with the bypass.`
        : "If it can't answer what you need, rerun with the bypass.";
    return {
      allow: false,
      reason: `${introduction} Call ${tool} with ${args} (load it with ToolSearch if it is deferred). ${scope} Rerun as \`${bypassCommand.trim()}\`.`,
    };
  }
  return { allow: true };
}
