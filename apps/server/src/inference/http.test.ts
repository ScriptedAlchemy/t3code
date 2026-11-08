import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";
import { InferenceProxy } from "./InferenceProxy.ts";
import * as InferenceHttp from "./http.ts";

it("streams an authorized request with a host key, then denies the revoked consumer", async () => {
  let active = true;
  let throttled = false;
  let closed = false;
  let upstreamCalls = 0;
  let finish: (() => void) | undefined;
  const client = HttpClient.make((request, _url, signal) =>
    Effect.sync(() => {
      upstreamCalls++;
      expect(request.url).toBe("http://127.0.0.1:43210/v1/messages?beta=true");
      expect(request.headers.authorization).toBe("Bearer private-host-key");
      expect(request.headers["anthropic-version"]).toBe("2023-06-01");
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers["x-api-key"]).toBeUndefined();
      signal.addEventListener("abort", () => {
        closed = true;
      });
      if (throttled)
        return HttpClientResponse.fromWeb(
          request,
          new Response("quota", { status: 429, headers: { "retry-after": "60" } }),
        );
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
          finish = () => controller.close();
        },
      });
      return HttpClientResponse.fromWeb(
        request,
        new Response(stream, {
          headers: { "content-type": "text/event-stream", "set-cookie": "secret=hidden" },
        }),
      );
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    InferenceHttp.layer.pipe(
      Layer.provide(
        Layer.mock(InferenceProxy)({
          authorize: (key) =>
            Effect.succeed(
              active && key === "consumer"
                ? { baseUrl: "http://127.0.0.1:43210", key: "private-host-key" }
                : null,
            ),
        }),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  const request = (path: string, key?: string) =>
    new Request("http://t3.test/api/inference/" + path, {
      method: "POST",
      body: "{}",
      headers: {
        "anthropic-version": "2023-06-01",
        cookie: "t3session=private",
        ...(key ? { "x-api-key": key } : {}),
      },
    });
  try {
    expect((await handler(request("v0/management/auth-files", "consumer"))).status).toBe(404);
    expect((await handler(request("v1/messages"))).status).toBe(401);
    const result = await handler(request("v1/messages?beta=true", "consumer"));
    expect(result.headers.get("set-cookie")).toBeNull();
    const reader = result.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    finish!();
    expect((await reader.read()).done).toBe(true);
    expect(closed).toBe(true);
    closed = false;
    const interrupted = await handler(request("v1/messages?beta=true", "consumer"));
    const activeReader = interrupted.body!.getReader();
    await activeReader.read();
    await activeReader.cancel();
    expect(closed).toBe(true);
    throttled = true;
    const limited = await handler(request("v1/messages?beta=true", "consumer"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.text()).toBe("quota");
    active = false;
    expect((await handler(request("v1/messages", "consumer"))).status).toBe(403);
    expect(upstreamCalls).toBe(3);
  } finally {
    await dispose();
  }
});
