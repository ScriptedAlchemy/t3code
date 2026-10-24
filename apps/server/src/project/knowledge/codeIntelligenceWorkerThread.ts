import * as NodeWorkerThreads from "node:worker_threads";

import {
  buildIndexInWorker,
  inspectCodeInWorker,
  type CodeIndexBuildInput,
  type CodeIntelligenceWorkerInput,
} from "./codeIntelligenceWorker.ts";

export type CodeIntelligenceCommand =
  | { readonly type: "query"; readonly input: CodeIntelligenceWorkerInput }
  | { readonly type: "build"; readonly input: CodeIndexBuildInput };

const port = NodeWorkerThreads.parentPort;
if (port !== null) {
  port.once("message", (command: CodeIntelligenceCommand) => {
    const run =
      command.type === "query"
        ? inspectCodeInWorker(command.input).then((result) => ({ result }))
        : buildIndexInWorker(command.input, (progress) => {
            port.postMessage({ progress });
          }).then((built) => ({ built }));
    void run
      .then(
        (reply) => port.postMessage(reply),
        (error: unknown) =>
          port.postMessage({
            error: error instanceof Error ? error.message : "code graph analysis failed",
          }),
      )
      .finally(() => port.close());
  });
}
