// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import * as NodeHttp from "node:http";
import type { EnvironmentId } from "@t3tools/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpServer } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { acceptsPrivateNetworkConnection } from "../startupAccess.ts";
import { isPrivateNetworkAddress } from "../startupAccess.ts";
import {
  guardHttpResponseWriteErrors,
  rejectRequestsUntilServing,
} from "../httpResponseErrorGuard.ts";
import { loadLanCertificates } from "./LanCertificates.ts";
import * as ServerEnvironment from "./ServerEnvironment.ts";

export class LanHttps extends Context.Service<
  LanHttps,
  {
    readonly server: Option.Option<HttpServer.HttpServer["Service"]>;
    readonly state: SubscriptionRef.SubscriptionRef<
      Option.Option<{
        readonly certificateAuthority: string;
        readonly addresses: ReadonlyArray<string>;
      }>
    >;
    readonly environmentId: EnvironmentId;
  }
>()("t3/environment/LanHttps") {}

const names = () =>
  [
    ...new Set([
      "127.0.0.1",
      ...Object.values(NodeOS.networkInterfaces()).flatMap((entries) =>
        (entries ?? [])
          .filter((entry) => entry.family === "IPv4" && isPrivateNetworkAddress(entry.address))
          .map((entry) => entry.address),
      ),
    ]),
  ].sort();

export const layer = Layer.effect(
  LanHttps,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const environmentId = yield* identity.getEnvironmentId;
    const state = yield* SubscriptionRef.make<
      Option.Option<{
        readonly certificateAuthority: string;
        readonly addresses: ReadonlyArray<string>;
      }>
    >(Option.none());
    if (config.lanHttpsPort === undefined)
      return LanHttps.of({
        server: Option.none(),
        state,
        environmentId,
      });
    const start = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const initialNames = names();
      const certificates = yield* loadLanCertificates(initialNames, now);
      const raw = NodeHttps.createServer({ cert: certificates.certificate, key: certificates.key });
      const sockets = new Set<NodeNet.Socket>();
      raw.on("connection", (socket) => {
        if (!(socket instanceof NodeNet.Socket) || !acceptsPrivateNetworkConnection(socket))
          socket.destroy();
        else {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
        }
      });
      const secureScheme = (request: NodeHttp.IncomingMessage) => {
        request.headers["x-forwarded-proto"] = "https";
      };
      raw.prependListener("request", secureScheme);
      raw.prependListener("upgrade", secureScheme);
      rejectRequestsUntilServing(guardHttpResponseWriteErrors(raw as unknown as NodeHttp.Server));
      const server = yield* NodeHttpServer.make(() => raw as unknown as NodeHttp.Server, {
        host: "0.0.0.0",
        port: config.lanHttpsPort,
        gracefulShutdownTimeout: 0,
        websocket: { perMessageDeflate: true },
      });
      const refresh = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const nextNames = names();
        const next = yield* loadLanCertificates(nextNames, now);
        yield* Effect.sync(() => raw.setSecureContext({ cert: next.certificate, key: next.key }));
        const current = yield* SubscriptionRef.get(state);
        if (Option.isNone(current) || current.value.addresses.join("\0") !== nextNames.join("\0")) {
          yield* SubscriptionRef.set(
            state,
            Option.some({ certificateAuthority: next.authorityCertificate, addresses: nextNames }),
          );
        }
      });
      yield* SubscriptionRef.set(
        state,
        Option.some({
          certificateAuthority: certificates.authorityCertificate,
          addresses: initialNames,
        }),
      );
      yield* refresh.pipe(
        Effect.repeat(Schedule.spaced("1 minute")),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* SubscriptionRef.set(state, Option.none());
            yield* Effect.sync(() => {
              raw.close();
              for (const socket of sockets) socket.destroy();
            });
            yield* Effect.logError("LAN HTTPS stopped", error);
          }),
        ),
        Effect.forkScoped,
      );
      return LanHttps.of({
        server: Option.some(server),
        state,
        environmentId,
      });
    });
    return yield* start.pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logError("LAN HTTPS unavailable", error);
          return LanHttps.of({
            server: Option.none(),
            state,
            environmentId,
          });
        }),
      ),
    );
  }),
).pipe(Layer.provide(ServerEnvironment.layerIdentity), Layer.provide(ServerSecretStore.layer));
