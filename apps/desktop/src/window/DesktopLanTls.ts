import { ipcMain, type BrowserWindow } from "electron";
import { createLanTlsClient } from "@t3tools/shared/nodeLanTls";
import type { LanTlsTrust } from "@t3tools/contracts";

const ACQUIRE = "desktop:lan-tls-acquire";
const RELEASE = "desktop:lan-tls-release";
const OPEN = "desktop:lan-tls-websocket-open";
const SEND = "desktop:lan-tls-websocket-send";
const CLOSE = "desktop:lan-tls-websocket-close";
const EVENT = "desktop:lan-tls-websocket-event";
const ACK = "desktop:lan-tls-websocket-ack";
const MAX_LEASES = 128;
const MAX_SOCKETS = 128;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

type Client = ReturnType<typeof createLanTlsClient>;
type Entry = { tls: LanTlsTrust; transport: Client; leases: Set<string> };

export function installDesktopLanTls(window: BrowserWindow): void {
  const contents = window.webContents;
  const session = contents.session;
  const entries = new Map<string, Entry>();
  const leases = new Map<string, string>();
  let nextLeaseId = 0;
  const sockets = new Map<string, ReturnType<Client["openWebSocket"]>>();
  const pending = new Map<string, Map<number, number>>();
  let nextSequence = 0;
  let pendingBytes = 0;
  let pendingCount = 0;
  const paused = new Set<string>();
  const resumeIfPossible = () => {
    if (pendingBytes > MAX_FRAME_BYTES / 4 || pendingCount > 256) return;
    for (const id of paused) sockets.get(id)?.resume();
    paused.clear();
  };
  const clearPending = (id: string) => {
    const frames = pending.get(id);
    if (!frames) return;
    for (const size of frames.values()) {
      pendingBytes -= size;
      pendingCount--;
    }
    pending.delete(id);
    resumeIfPossible();
  };
  const validSender = (event: Electron.IpcMainInvokeEvent) =>
    event.sender === contents && event.senderFrame === contents.mainFrame;
  const requireSender = (event: Electron.IpcMainInvokeEvent) => {
    if (!validSender(event)) throw new Error("Invalid LAN TLS sender");
  };
  const event = (id: string, type: string, data?: unknown) => {
    if (!contents.isDestroyed()) contents.send(EVENT, { id, type, data });
  };
  session.protocol.handle("https", (request) => {
    const entry = entries.get(new URL(request.url).origin);
    return entry
      ? entry.transport.fetch(request)
      : session.fetch(request, { bypassCustomProtocolHandlers: true });
  });
  ipcMain.handle(ACQUIRE, (event, input: { httpBaseUrl: string; tls: LanTlsTrust }) => {
    requireSender(event);
    if (leases.size >= MAX_LEASES) throw new Error("Too many LAN TLS leases");
    const origin = new URL(input.httpBaseUrl).origin;
    const existing = entries.get(origin);
    for (const entry of entries.values()) {
      if (
        entry.tls.environmentId === input.tls.environmentId &&
        entry.tls.certificateAuthority !== input.tls.certificateAuthority
      )
        throw new Error("Conflicting environment certificate authority");
    }
    if (
      existing &&
      (existing.tls.environmentId !== input.tls.environmentId ||
        existing.tls.certificateAuthority !== input.tls.certificateAuthority)
    )
      throw new Error("Conflicting origin certificate authority");
    const entry = existing ?? {
      tls: input.tls,
      transport: createLanTlsClient(input),
      leases: new Set<string>(),
    };
    const id = String(nextLeaseId++);
    entry.leases.add(id);
    entries.set(origin, entry);
    leases.set(id, origin);
    return id;
  });
  ipcMain.handle(RELEASE, async (event, id: string) => {
    requireSender(event);
    const origin = leases.get(id);
    if (!origin) return;
    leases.delete(id);
    const entry = entries.get(origin);
    if (!entry) return;
    entry.leases.delete(id);
    if (entry.leases.size === 0) {
      entries.delete(origin);
      await entry.transport.close();
    }
  });
  ipcMain.handle(
    OPEN,
    (ipcEvent, input: { id: string; url: string; protocols?: string | string[] }) => {
      requireSender(ipcEvent);
      if (
        typeof input.id !== "string" ||
        input.id.length > 100 ||
        sockets.has(input.id) ||
        sockets.size >= MAX_SOCKETS
      )
        throw new Error("Invalid LAN TLS socket");
      const url = new URL(input.url);
      url.protocol = "https:";
      const entry = entries.get(url.origin);
      if (!entry) throw new Error("LAN TLS route is not enrolled");
      const socket = entry.transport.openWebSocket(input.url, input.protocols);
      sockets.set(input.id, socket);
      socket.on("open", () => event(input.id, "open"));
      socket.on("message", (data, binary) => {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data;
        if (bytes.byteLength > MAX_FRAME_BYTES) {
          socket.close(1009);
          return;
        }
        if (pendingBytes + bytes.byteLength > MAX_FRAME_BYTES || pendingCount >= 1024) {
          socket.terminate();
          return;
        }
        const sequence = nextSequence++;
        const frames = pending.get(input.id) ?? new Map<number, number>();
        frames.set(sequence, bytes.byteLength);
        pending.set(input.id, frames);
        pendingBytes += bytes.byteLength;
        pendingCount++;
        if (pendingBytes >= MAX_FRAME_BYTES / 2 || pendingCount >= 512) {
          socket.pause();
          paused.add(input.id);
        }
        if (!contents.isDestroyed())
          contents.send(EVENT, {
            id: input.id,
            type: "message",
            data: binary ? Uint8Array.from(bytes) : bytes.toString(),
            sequence,
          });
      });
      socket.on("error", () => event(input.id, "error"));
      socket.on("close", (code, reason) => {
        sockets.delete(input.id);
        paused.delete(input.id);
        clearPending(input.id);
        event(input.id, "close", { code, reason: reason.toString() });
      });
    },
  );
  ipcMain.handle(ACK, (ipcEvent, input: { id: string; sequence: number }) => {
    requireSender(ipcEvent);
    const frames = pending.get(input.id);
    const size = frames?.get(input.sequence);
    if (size === undefined) return;
    frames!.delete(input.sequence);
    if (frames!.size === 0) pending.delete(input.id);
    pendingBytes -= size;
    pendingCount--;
    resumeIfPossible();
  });
  ipcMain.handle(SEND, (ipcEvent, input: { id: string; data: string | Uint8Array }) => {
    requireSender(ipcEvent);
    if (
      (typeof input.data !== "string" && !(input.data instanceof Uint8Array)) ||
      (typeof input.data === "string" ? Buffer.byteLength(input.data) : input.data.byteLength) >
        MAX_FRAME_BYTES
    )
      throw new Error("Invalid LAN TLS frame");
    const socket = sockets.get(input.id);
    if (!socket || socket.bufferedAmount > MAX_FRAME_BYTES)
      throw new Error("LAN TLS socket unavailable");
    socket.send(input.data);
  });
  ipcMain.handle(CLOSE, (ipcEvent, input: { id: string; code?: number; reason?: string }) => {
    requireSender(ipcEvent);
    sockets.get(input.id)?.close(input.code, input.reason);
  });
  const clear = () => {
    const clients = [...entries.values()].map((entry) => entry.transport);
    entries.clear();
    leases.clear();
    sockets.clear();
    pending.clear();
    paused.clear();
    pendingBytes = 0;
    pendingCount = 0;
    for (const client of clients) void client.close();
  };
  contents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) clear();
  });
  contents.once("destroyed", () => {
    for (const channel of [ACQUIRE, RELEASE, OPEN, SEND, CLOSE, ACK])
      ipcMain.removeHandler(channel);
    session.protocol.unhandle("https");
    clear();
  });
}
