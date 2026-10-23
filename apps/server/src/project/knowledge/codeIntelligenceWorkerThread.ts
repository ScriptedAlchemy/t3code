import * as NodeWorkerThreads from "node:worker_threads";

import { inspectCodeInWorker, type CodeIntelligenceWorkerInput } from "./codeIntelligenceWorker.ts";

type WorkerCommand =
  | { readonly type: "query"; readonly input: CodeIntelligenceWorkerInput }
  | { readonly type: "cancel" };

const port = NodeWorkerThreads.parentPort;
if (port !== null) {
  const controller = new AbortController();
  let started = false;
  port.on("message", (command: WorkerCommand) => {
    if (command.type === "cancel") {
      controller.abort();
      return;
    }
    if (started) return;
    started = true;
    void inspectCodeInWorker(command.input, controller.signal, (progress) => {
      port.postMessage({ progress });
    })
      .then(
        (result) => port.postMessage({ result }),
        (error: unknown) =>
          port.postMessage({
            error: error instanceof Error ? error.message : "code graph analysis failed",
          }),
      )
      .finally(() => port.close());
  });
}
