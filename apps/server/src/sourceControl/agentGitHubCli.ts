// @effect-diagnostics nodeBuiltinImport:off - CLI process boundary forwards the real gh's stdio and lifetime.
import * as NodeChildProcess from "node:child_process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

import { decideGitHubArguments } from "./agentGitHubReads.ts";

/** Refused reads use the same tool redirect as the native hook; all other argv reach real gh intact. */
export async function runAgentGitHubCli(
  realCommand: string,
  args: ReadonlyArray<string>,
): Promise<void> {
  const decision = decideGitHubArguments(args, process.env);
  if (!decision.allow) {
    process.stderr.write(`${decision.reason}\n`);
    process.exitCode = 1;
    return;
  }
  const resolved = await Effect.runPromise(
    resolveSpawnCommand(realCommand, args, { env: process.env }),
  );
  await new Promise<void>((resolve) => {
    const child = NodeChildProcess.spawn(resolved.command, resolved.args, {
      env: process.env,
      stdio: "inherit",
      shell: resolved.shell,
      windowsHide: true,
    });
    const forwardInterrupt = () => child.kill("SIGINT");
    const forwardTerminate = () => child.kill("SIGTERM");
    process.on("SIGINT", forwardInterrupt);
    process.on("SIGTERM", forwardTerminate);
    const cleanup = () => {
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTerminate);
    };
    child.once("error", () => {
      cleanup();
      process.stderr.write(
        "Could not start the installed GitHub CLI. Restart the provider session after installing or moving gh.\n",
      );
      process.exitCode = 127;
      resolve();
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal !== null) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
      resolve();
    });
  });
}
