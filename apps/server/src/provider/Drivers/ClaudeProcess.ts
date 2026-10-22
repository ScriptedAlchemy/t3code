import type {
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess as ClaudeSpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import * as NodeChildProcess from "node:child_process";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { claudeCliEnvironment } from "./ClaudeHome.ts";

const CLAUDE_GROUP_WATCH_SCRIPT = [
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'exec "$@" 3<&-',
].join("\n");

/**
 * When the CLI exits it stops the MCP servers it started, but not their children: a plugin's
 * `bun run start` wrapper dies and its `bun server.ts` keeps running, writing to a pipe nobody
 * reads (#3089). Those stay in the CLI's group, so the rest of the group gets SIGKILL once the
 * CLI exits for any reason.
 *
 * The CLI keeps working after its pipes close. A watcher in its group reads a pipe only this
 * server holds and stops the group at end-of-file, including when this server crashes (#23370).
 */
export function spawnClaudeProcess(
  options: ClaudeSpawnOptions,
  platform: NodeJS.Platform,
  configDir?: string,
): ClaudeSpawnedProcess {
  const child = NodeChildProcess.spawn(
    platform === "win32" ? options.command : "/bin/sh",
    platform === "win32"
      ? options.args
      : ["-c", CLAUDE_GROUP_WATCH_SCRIPT, "t3-claude", options.command, ...options.args],
    {
      cwd: options.cwd,
      env: configDir === undefined ? options.env : claudeCliEnvironment(options.env, configDir),
      signal: options.signal,
      stdio: platform === "win32" ? ["pipe", "pipe", "ignore"] : ["pipe", "pipe", "ignore", "pipe"],
      detached: platform !== "win32",
      windowsHide: true,
    },
  );
  child.once("exit", () => {
    if (platform === "win32") return;
    try {
      signalProcessGroup(child.pid ?? 0, "SIGKILL");
    } catch {}
  });
  // Node's typings make stdin and stdout nullable once stdio has a fourth entry; both are pipes.
  return child as ClaudeSpawnedProcess;
}
