// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeIncomingDecisionShadow } from "./IncomingDecisionShadow.ts";

const configuration = JSON.stringify({
  mode: "shadow",
  port: 8009,
  model: "candidate-under-evaluation",
  device: "metal",
});
const incoming = () => ({
  content: [{ type: "text", text: `${"Evidence\n".repeat(40)}\nrequired/path.ts\n` }],
});
const completion = (choices: string[] = ["keep", "drop"], model = "candidate-under-evaluation") =>
  Response.json({
    model,
    answers: Object.fromEntries(
      choices.map((choice, id) => [
        String(id),
        {
          type: "choice",
          choice,
          confidence: 0.5,
          probabilities: { keep: 0.3, drop: 0.3, abstain: 0.4 },
        },
      ]),
    ),
    usage: { input_tokens: 1, output_tokens: 1 },
  });

describe("IncomingDecisionShadow", () => {
  it.live("uses the local HTTP runtime and refuses redirects", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const server = NodeHttp.createServer((request, response) => {
        requests.push(request.url ?? "");
        if (requests.length === 2) {
          response.writeHead(302, { location: "https://example.invalid/cloud-inference" });
          response.end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            model: "local-fixture",
            answers: Object.fromEntries(
              ["0", "1"].map((id) => [
                id,
                {
                  type: "choice",
                  choice: "keep",
                  confidence: 0.5,
                  probabilities: { keep: 0.5, drop: 0.3, abstain: 0.2 },
                },
              ]),
            ),
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      );
      try {
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("Expected TCP listener");
        const service = yield* makeIncomingDecisionShadow(
          JSON.stringify({
            mode: "shadow",
            port: address.port,
            model: "local-fixture",
            device: "metal",
          }),
        );
        expect((yield* service.observe(incoming())).receipt.status).toBe("decision");
        expect((yield* service.observe(incoming())).receipt.status).toBe("failed");
        expect(requests).toEqual(["/v1/systemone", "/v1/systemone"]);
      } finally {
        server.closeAllConnections();
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        );
      }
    }),
  );

  it.effect(
    "evaluates decoded incoming leaves without mutating content or receiving a cached prefix",
    () =>
      Effect.gen(function* () {
        const result = incoming();
        const before = JSON.stringify(result);
        const requests: RequestInit[] = [];
        const service = yield* makeIncomingDecisionShadow(configuration, async (url, init) => {
          expect(url).toBe("http://127.0.0.1:8009/v1/systemone");
          expect(init?.redirect).toBe("error");
          requests.push(init!);
          return completion();
        });
        expect((yield* service.observe(result)).receipt).toMatchObject({
          status: "decision",
          applied: false,
          blocks: 2,
          proposed: { "0": { kind: "keep" }, "1": { kind: "drop" } },
        });
        expect(JSON.stringify(result)).toBe(before);
        const body = JSON.parse(String(requests[0]!.body));
        expect(body.model).toBe("candidate-under-evaluation");
        expect(body.state.map((block: { text: string }) => block.text)).toEqual([
          `${"Evidence\n".repeat(40)}\n`,
          "required/path.ts\n",
        ]);
        expect(Object.keys(body.questions)).toEqual(["0", "1"]);
        expect(requests[0]!.headers).toEqual({ "content-type": "application/json" });
      }),
  );

  it.effect("fails closed on configuration and eligibility while keeping originals", () =>
    Effect.gen(function* () {
      let calls = 0;
      const request: typeof fetch = async () => {
        calls++;
        throw new Error("must not call");
      };
      for (const config of [
        undefined,
        "{}",
        configuration.replace('"shadow"', '"prune"'),
        configuration.replace("8009", "443"),
      ]) {
        const service = yield* makeIncomingDecisionShadow(config, request);
        expect((yield* service.observe(incoming())).receipt.status).toBe(
          config === undefined ? "disabled" : "invalid-config",
        );
      }
      const service = yield* makeIncomingDecisionShadow(configuration, request);
      for (const result of [
        { ...incoming(), isError: true },
        { ...incoming(), structuredContent: { required: true } },
        { content: [{ type: "image", data: "encoded" }] },
        { content: [{ type: "text", text: "small" }] },
        { content: [{ type: "text", text: "x".repeat(16385) }] },
        { content: [{ type: "text", text: "x\n\n".repeat(100) }] },
        { content: [{ type: "text", text: "x".repeat(300), annotations: { audience: ["user"] } }] },
      ])
        expect((yield* service.observe(result)).receipt.status).toBe("ineligible");
      expect(calls).toBe(0);
    }),
  );

  it.effect("rejects malformed, oversized, truncated and invalid decisions", () =>
    Effect.gen(function* () {
      for (const response of [
        new Response(null, { status: 503 }),
        new Response("x".repeat(16385)),
        completion(["keep"]),
        completion(["keep", "drop"], "wrong-model"),
        Response.json({}),
        new Response("not json"),
        new Response("{}", { headers: { "X-MLX-Decision-Truncated": "true" } }),
      ]) {
        const service = yield* makeIncomingDecisionShadow(configuration, async () => response);
        const result = incoming();
        const before = JSON.stringify(result);
        expect((yield* service.observe(result)).receipt.status).toBe("failed");
        expect(JSON.stringify(result)).toBe(before);
      }
    }),
  );

  it.effect("refuses an all-drop selection", () =>
    Effect.gen(function* () {
      const result = incoming();
      const service = yield* makeIncomingDecisionShadow(
        configuration,
        async () => completion(["drop", "drop"]),
        "test-select",
      );
      const observed = yield* service.observe(result);
      expect(observed.result).toEqual(result);
      expect(observed.receipt.applied).toBe(false);
    }),
  );

  it.effect("bounds concurrent work and aborts overdue requests without a queue or retry", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal>();
      let calls = 0;
      const service = yield* makeIncomingDecisionShadow(configuration, async (_url, init) => {
        calls++;
        Deferred.doneUnsafe(started, Effect.succeed(init!.signal!));
        return new Promise<Response>(() => {});
      });
      const pending = yield* Effect.forkChild(service.observe(incoming()));
      const signal = yield* Deferred.await(started);
      expect((yield* service.observe(incoming())).receipt.status).toBe("busy");
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(pending)).receipt).toMatchObject({
        status: "timeout",
        elapsedMs: 1000,
      });
      expect(signal.aborted).toBe(true);
      const afterTimeout = yield* service.observe(incoming());
      expect(afterTimeout.receipt.status).toBe("unavailable");
      expect(afterTimeout.result).toEqual(incoming());
      expect(calls).toBe(1);
    }),
  );
});
