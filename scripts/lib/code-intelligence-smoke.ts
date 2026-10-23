// @effect-diagnostics nodeBuiltinImport:off - the smoke speaks Node IPC, which effect/process does not expose.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class CodeIntelligenceSmokeError extends Schema.TaggedError<CodeIntelligenceSmokeError>()(
  "CodeIntelligenceSmokeError",
  { command: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `${this.command} __code-intelligence could not answer a code query: ${this.detail}`;
  }
}

const decodeReply = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({
      result: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ name: Schema.String })) }),
    }),
    Schema.Struct({ error: Schema.String }),
  ]),
);

/**
 * Answers one `callers` query through `<command> <args> __code-intelligence` on a throwaway
 * checkout, the way the server does. A packaged server passes only if its executable accepts
 * its baked V8 flags, dispatches the subcommand, and its worker loads the CodeGraph SDK.
 */
export const smokeCodeIntelligenceProcess = Effect.fn("smokeCodeIntelligenceProcess")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const fail = (detail: string) => new CodeIntelligenceSmokeError({ command, detail });
  const callers = yield* Effect.acquireUseRelease(
    Effect.promise(async () => {
      const checkout = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-code-smoke-"));
      await NodeFSP.mkdir(NodePath.join(checkout, "src"));
      await NodeFSP.writeFile(
        NodePath.join(checkout, "src/a.ts"),
        "export function greet() { return 1; }\nexport function caller() { return greet(); }\n",
      );
      return checkout;
    }),
    (checkout) =>
      Effect.callback<ReadonlyArray<string>, CodeIntelligenceSmokeError>((resume) => {
        const child = NodeChildProcess.spawn(command, [...args, "__code-intelligence"], {
          env: { ...process.env, CODEGRAPH_DIR: ".codegraph-t3", ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        });
        let reply: string | ReadonlyArray<string> | undefined;
        child.on("message", (message: unknown) => {
          const decoded = decodeReply(message);
          if (decoded._tag === "None") return;
          reply =
            "error" in decoded.value
              ? decoded.value.error
              : decoded.value.result.nodes.map((node) => node.name);
        });
        child.once("error", (error) => resume(Effect.fail(fail(error.message))));
        child.once("close", (code, signal) => {
          if (typeof reply === "object") resume(Effect.succeed(reply));
          else resume(Effect.fail(fail(reply ?? `exited with ${code ?? signal} and no result`)));
        });
        child.send({
          type: "query",
          input: {
            checkoutPath: checkout,
            files: ["src/a.ts"],
            filesListed: 1,
            listingTruncated: false,
            query: { operation: "callers", symbol: { name: "greet" } },
          },
        });
        return Effect.sync(() => child.kill("SIGKILL"));
      }).pipe(
        Effect.timeoutOrElse({
          duration: "60 seconds",
          orElse: () => Effect.fail(fail("no answer within 60 seconds")),
        }),
      ),
    (checkout) => Effect.promise(() => NodeFSP.rm(checkout, { recursive: true, force: true })),
  );
  if (!callers.includes("caller")) {
    return yield* fail(`expected 'caller' among [${callers.join(", ")}]`);
  }
});
