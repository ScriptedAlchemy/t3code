// @effect-diagnostics nodeBuiltinImport:off - the analysis process only relays between IPC and its worker.
import * as NodeWorkerThreads from "node:worker_threads";

const WORKER_MEMORY_LIMIT_MB = 768;

/**
 * The child isolates fatal WASM aborts and passes its process-wide liftoff-only flag to the worker.
 * Executables can load sibling scripts only through workers.
 */
export function hostCodeIntelligenceWorker(): void {
  const send = process.send?.bind(process);
  if (send === undefined) {
    process.exitCode = 1;
    return;
  }
  const fromSource = import.meta.url.endsWith(".ts");
  const worker = new NodeWorkerThreads.Worker(
    new URL(
      fromSource
        ? "./codeIntelligenceWorkerThread.ts"
        : "./project/knowledge/codeIntelligenceWorkerThread.mjs",
      import.meta.url,
    ),
    {
      ...(fromSource ? { execArgv: ["--experimental-strip-types"] } : {}),
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_LIMIT_MB },
    },
  );
  let delivered = Promise.resolve();
  worker.on("message", (message: unknown) => {
    delivered = delivered.then(
      () => new Promise<void>((resolve) => send(message, undefined, {}, () => resolve())),
    );
  });
  worker.once("error", () => {
    process.exitCode = 1;
  });
  worker.once("exit", (code) => {
    void delivered.then(() => process.exit(process.exitCode ?? code));
  });
  process.on("message", (message: unknown) => worker.postMessage(message));
  // An analysis whose server went away has no one to answer.
  process.once("disconnect", () => process.exit(1));
}
