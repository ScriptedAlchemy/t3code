import * as NodeWorkerThreads from "node:worker_threads";

import { inspectCodeInWorker, type CodeIntelligenceWorkerInput } from "./codeIntelligenceWorker.ts";

const port = NodeWorkerThreads.parentPort;
if (port !== null) {
  port.once(
    "message",
    (command: { readonly type: "query"; readonly input: CodeIntelligenceWorkerInput }) => {
      void inspectCodeInWorker(command.input, (progress) => {
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
    },
  );
}
