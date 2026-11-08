import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { InferenceProxy } from "./InferenceProxy.ts";
import { inferencePath } from "./routes.ts";

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const path = inferencePath(request.method, request.url);
  if (!path) return HttpServerResponse.empty({ status: 404 });
  const key =
    request.headers.authorization?.match(/^Bearer ([^ ]+)$/i)?.[1] ?? request.headers["x-api-key"];
  if (!key) return HttpServerResponse.empty({ status: 401 });
  const host = yield* InferenceProxy;
  const target = yield* host.authorize(key);
  if (!target) return HttpServerResponse.empty({ status: 403 });
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const headers: Record<string, string> = { authorization: "Bearer " + target.key };
  for (const name of [
    "accept",
    "content-encoding",
    "anthropic-version",
    "anthropic-beta",
    "session_id",
    "session-id",
    "x-session-id",
    "x-client-request-id",
    "x-claude-code-session-id",
  ]) {
    const value = request.headers[name];
    if (value) headers[name] = value;
  }
  const outgoing = HttpClientRequest.make(request.method === "GET" ? "GET" : "POST")(
    target.baseUrl + path,
  ).pipe(
    HttpClientRequest.setHeaders(headers),
    request.method === "POST"
      ? HttpClientRequest.bodyStream(request.stream, { contentType: "application/json" })
      : (req) => req,
  );
  const result = yield* client
    .execute(outgoing)
    .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  return HttpServerResponse.stream(result.stream, {
    status: result.status,
    contentType: result.headers["content-type"] ?? "application/json",
    headers: {
      "cache-control": "no-store, no-transform",
      ...(result.headers["retry-after"] ? { "retry-after": result.headers["retry-after"] } : {}),
    },
  });
}).pipe(
  Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 502 })),
  Effect.withTracerEnabled(false),
);
export const layer = Layer.unwrap(
  Effect.map(InferenceProxy, (host) =>
    HttpRouter.add(
      "*",
      "/api/inference/*",
      handler.pipe(Effect.provideService(InferenceProxy, host)),
    ),
  ),
);
