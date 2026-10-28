import { expect, it, vi } from "vite-plus/test";
import type { DesktopBridge, DesktopLanTlsSocketEvent } from "@t3tools/contracts";
import { createDesktopWebSocket } from "./desktopWebSocket";

it("delivers pinned socket messages to both browser event styles", async () => {
  let listener: ((event: DesktopLanTlsSocketEvent) => void) | undefined;
  const send = vi.fn(async (_input: { id: string; data: string | Uint8Array }) => {});
  const open = vi.fn(async (_input: { id: string; url: string }) => {});
  const bridge = {
    isLanTlsOrigin: () => true,
    onLanTlsSocketEvent: (callback: (event: DesktopLanTlsSocketEvent) => void) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    openLanTlsSocket: open,
    sendLanTlsSocket: send,
    acknowledgeLanTlsSocket: async () => {},
    closeLanTlsSocket: async () => {},
  } as unknown as DesktopBridge;
  vi.stubGlobal("window", { desktopBridge: bridge });
  try {
    const socket = createDesktopWebSocket("wss://127.0.0.1:3774/ws");
    const id = open.mock.calls[0]![0].id;
    let opened = false;
    let received: ArrayBuffer | undefined;
    socket.addEventListener("open", () => {
      opened = true;
    });
    socket.onmessage = (event) => {
      received = event.data as ArrayBuffer;
    };
    socket.binaryType = "arraybuffer";
    listener!({ id, type: "open" });
    listener!({ id, type: "message", data: new Uint8Array([1, 2, 3]), sequence: 0 });
    socket.send("hello");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ id, data: "hello" }));
    expect(opened).toBe(true);
    expect(Array.from(new Uint8Array(received!))).toEqual([1, 2, 3]);
  } finally {
    vi.unstubAllGlobals();
  }
});
