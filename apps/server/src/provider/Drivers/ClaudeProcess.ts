import type {
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess as ClaudeSpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import * as NodeChildProcess from "node:child_process";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { claudeCliEnvironment } from "./ClaudeHome.ts";

/**
 * When the CLI exits it stops the MCP servers it started, but not their children: a plugin's
 * `bun run start` wrapper dies and its `bun server.ts` keeps running, writing to a pipe nobody
 * reads (#3089). Those stay in the CLI's group, so the rest of the group gets SIGKILL once the
 * CLI exits for any reason.
 */
export function spawnClaudeProcess(
  options: ClaudeSpawnOptions,
  platform: NodeJS.Platform,
  configDir?: string,
): ClaudeSpawnedProcess {
  const child = NodeChildProcess.spawn(options.command, options.args, {
    cwd: options.cwd,
    env: configDir === undefined ? options.env : claudeCliEnvironment(options.env, configDir),
    signal: options.signal,
    stdio: ["pipe", "pipe", "ignore"],
    detached: platform !== "win32",
    windowsHide: true,
  });
  child.once("exit", () => {
    if (platform === "win32") return;
    try {
      signalProcessGroup(child.pid ?? 0, "SIGKILL");
    } catch {}
  });
  return child;
}
