import { NodeHttpServer } from "@effect/platform-node";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientResponse,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

const environmentId = EnvironmentId.make("environment:peer");
const peerLayer = (url: string) =>
  PeerMcpClient.layer.pipe(
    Layer.provide(
      Layer.mock(PeerLinks.PeerLinks)({
        resolve: () =>
          Effect.succeed({
            url,
            token: "test-peer-token",
            link: {
              environmentId,
              label: "Peer",
              urls: [url],
              access: "auto",
              linkedAt: DateTime.makeUnsafe(0),
              expiresAt: DateTime.makeUnsafe(1_000_000),
              lastReachedAt: null,
              lastError: null,
            },
          }),
        recordOutcome: () => Effect.void,
      }),
    ),
  );

const callPeer = Effect.gen(function* () {
  const client = yield* PeerMcpClient.PeerMcpClient;
  return yield* client.call({
    environmentId,
    tool: "t3_thread_launch",
    arguments: { title: "Run once", clientRequestId: "same-launch" },
    limits: { runtimeMode: "auto", interactionMode: "default" },
    success: Schema.Struct({ answer: Schema.String }),
  });
});

const toolResponse = (id: number) => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text: JSON.stringify({ answer: "done" }) }] },
});

const responseClient = (
  body: string | ReadableStream<Uint8Array>,
  contentType = "text/event-stream",
) => {
  let requests = 0;
  return HttpClient.make((request) =>
    Effect.sync(() => {
      requests++;
      return HttpClientResponse.fromWeb(
        request,
        requests === 1
          ? Response.json(
              { jsonrpc: "2.0", id: 0, result: {} },
              { headers: { "mcp-session-id": "session" } },
            )
          : requests === 2
            ? new Response(null, { status: 202 })
            : new Response(body, { headers: { "content-type": contentType } }),
      );
    }),
  );
};

it.effect("reads the matching MCP response among SSE notifications and other response IDs", () => {
  const body = [
    ": keepalive\r\nretry: 1000\r\n\r\n",
    'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\n',
    `data: ${JSON.stringify(toolResponse(999))}\r\n\r\n`,
    `event: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":1,"result":${JSON.stringify(toolResponse(1).result)}}\r\n\r\n`,
  ].join("");
  return callPeer.pipe(
    Effect.tap((result) => Effect.sync(() => expect(result).toEqual({ answer: "done" }))),
    Effect.provide(
      peerLayer("http://peer.test").pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, responseClient(body))),
      ),
    ),
  );
});

it.effect("returns the MCP response before SSE closes and releases the body reader", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(toolResponse(1))}\n\n`),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = yield* callPeer.pipe(
      Effect.provide(
        peerLayer("http://peer.test").pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, responseClient(body))),
        ),
      ),
    );
    expect(result).toEqual({ answer: "done" });
    expect(cancelled).toBe(true);
  }),
);

it.effect("refuses a JSON response for another MCP request", () =>
  callPeer.pipe(
    Effect.flip,
    Effect.tap((error) => Effect.sync(() => expect(error.code).toBe("orchestration_error"))),
    Effect.provide(
      peerLayer("http://peer.test").pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            responseClient(JSON.stringify(toolResponse(999)), "application/json"),
          ),
        ),
      ),
    ),
  ),
);

it.effect("decodes structured MCP results without requiring JSON text content", () =>
  callPeer.pipe(
    Effect.tap((result) => Effect.sync(() => expect(result).toEqual({ answer: "done" }))),
    Effect.provide(
      peerLayer("http://peer.test").pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            responseClient(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: { content: [], structuredContent: { answer: "done" } },
              }),
              "application/json",
            ),
          ),
        ),
      ),
    ),
  ),
);

const serveRaw = <E, R>(
  handle: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Layer.build(Layer.fresh(NodeHttpServer.layerTest)).pipe(
    Effect.flatMap((server) =>
      Effect.gen(function* () {
        yield* HttpServer.serve(Effect.flatMap(HttpServerRequest.HttpServerRequest, handle)).pipe(
          Layer.build,
        );
        const address = (yield* HttpServer.HttpServer).address;
        if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
        return `http://127.0.0.1:${address.port}`;
      }).pipe(Effect.provideContext(server)),
    ),
  );

it.effect("does not follow an MCP redirect with the tool's arguments", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received = yield* Ref.make<ReadonlyArray<string>>([]);
      const elsewhere = yield* serveRaw((request) =>
        request.text.pipe(
          Effect.flatMap((body) => Ref.update(received, (seen) => [...seen, body])),
          Effect.as(HttpServerResponse.jsonUnsafe(toolResponse(1))),
        ),
      );
      const front = yield* serveRaw((request) =>
        request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ method: Schema.String }))),
          Effect.map(({ method }) =>
            method === "initialize"
              ? HttpServerResponse.jsonUnsafe(
                  { jsonrpc: "2.0", id: 0, result: {} },
                  { headers: { "mcp-session-id": "session" } },
                )
              : method === "notifications/initialized"
                ? HttpServerResponse.empty({ status: 202 })
                : HttpServerResponse.empty({
                    status: 307,
                    headers: { location: `${elsewhere}/mcp` },
                  }),
          ),
        ),
      );
      const result = yield* callPeer.pipe(
        Effect.result,
        Effect.provide(peerLayer(front).pipe(Layer.provide(FetchHttpClient.layer))),
      );
      expect(yield* Ref.get(received)).toEqual([]);
      expect(result._tag).toBe("Failure");
    }),
  ),
);
