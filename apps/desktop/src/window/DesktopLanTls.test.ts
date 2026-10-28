import * as NodeEvents from "node:events";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => unknown>(),
  client: { openWebSocket: vi.fn(), fetch: vi.fn(), close: vi.fn(async () => {}) },
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, input: unknown) => unknown) =>
      mocks.handlers.set(channel, handler),
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
  },
}));
vi.mock("@t3tools/shared/nodeLanTls", () => ({ createLanTlsClient: () => mocks.client }));

import { installDesktopLanTls } from "./DesktopLanTls.ts";

it("pauses a flooded socket until the renderer acknowledges its receive window", async () => {
  mocks.handlers.clear();
  const socket = Object.assign(new NodeEvents.EventEmitter(), {
    pause: vi.fn(),
    resume: vi.fn(),
    terminate: vi.fn(),
    close: vi.fn(),
    send: vi.fn(),
    bufferedAmount: 0,
  });
  mocks.client.openWebSocket.mockReturnValue(socket);
  const messages: Array<{ id: string; type: string; sequence?: number }> = [];
  const contents = Object.assign(new NodeEvents.EventEmitter(), {
    mainFrame: {},
    session: { protocol: { handle: vi.fn(), unhandle: vi.fn() }, fetch: vi.fn() },
    isDestroyed: () => false,
    send: (_channel: string, message: (typeof messages)[number]) => messages.push(message),
  });
  installDesktopLanTls({ webContents: contents } as unknown as Electron.BrowserWindow);
  const invoke = (channel: string, value: unknown) =>
    mocks.handlers.get(channel)!({ sender: contents, senderFrame: contents.mainFrame }, value);
  const lease = invoke("desktop:lan-tls-acquire", {
    httpBaseUrl: "https://127.0.0.1:3774",
    tls: { environmentId: "env", certificateAuthority: "ca" },
  });
  invoke("desktop:lan-tls-websocket-open", { id: "socket", url: "wss://127.0.0.1:3774/ws" });
  for (let n = 0; n < 512; n++) socket.emit("message", Buffer.from("x"), false);
  expect(messages.filter((message) => message.type === "message")).toHaveLength(512);
  expect(socket.pause).toHaveBeenCalledOnce();
  for (const message of messages.slice(0, 256))
    invoke("desktop:lan-tls-websocket-ack", { id: "socket", sequence: message.sequence });
  expect(socket.resume).toHaveBeenCalledOnce();
  socket.emit("message", Buffer.from("y"), false);
  expect(messages).toHaveLength(513);
  socket.emit("close", 1000, Buffer.alloc(0));
  await invoke("desktop:lan-tls-release", lease);
  contents.emit("destroyed");
  expect(mocks.handlers.size).toBe(0);
});
