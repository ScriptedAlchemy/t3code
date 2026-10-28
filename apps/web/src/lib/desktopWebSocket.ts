import type * as Socket from "effect/socket/Socket";

export function createDesktopWebSocket(url: string, protocols?: string | string[]): WebSocket {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (!bridge || !bridge.isLanTlsOrigin(url)) return new WebSocket(url, protocols);

  // @effect-diagnostics-next-line cryptoRandomUUID:off -- IPC needs an immediate socket identifier.
  const id = crypto.randomUUID();
  const target = new EventTarget();
  let readyState: number = WebSocket.CONNECTING;
  let binaryType: BinaryType = "blob";
  let onopen: WebSocket["onopen"] = null;
  let onmessage: WebSocket["onmessage"] = null;
  let onerror: WebSocket["onerror"] = null;
  let onclose: WebSocket["onclose"] = null;
  let sends = Promise.resolve();
  let bufferedAmount = 0;
  const maxBufferedAmount = 8 * 1024 * 1024;
  const dispatch = (event: Event) => {
    target.dispatchEvent(event);
    if (event.type === "open") onopen?.call(socket, event);
    else if (event.type === "message") onmessage?.call(socket, event as MessageEvent);
    else if (event.type === "error") onerror?.call(socket, event);
    else if (event.type === "close") onclose?.call(socket, event as CloseEvent);
  };
  const unsubscribe = bridge.onLanTlsSocketEvent((event) => {
    if (event.id !== id) return;
    if (event.type === "open") {
      if (readyState !== WebSocket.CONNECTING) return;
      readyState = WebSocket.OPEN;
      dispatch(new Event("open"));
    } else if (event.type === "message") {
      const data =
        typeof event.data === "string"
          ? event.data
          : binaryType === "arraybuffer"
            ? Uint8Array.from(event.data).buffer
            : new Blob([Uint8Array.from(event.data)]);
      try {
        dispatch(new MessageEvent("message", { data }));
      } finally {
        void bridge.acknowledgeLanTlsSocket({ id, sequence: event.sequence }).catch(() => {});
      }
    } else if (event.type === "error") dispatch(new Event("error"));
    else {
      readyState = WebSocket.CLOSED;
      unsubscribe();
      dispatch(new CloseEvent("close", event.data));
    }
  });
  const socket = {
    url,
    get bufferedAmount() {
      return bufferedAmount;
    },
    get readyState() {
      return readyState;
    },
    get binaryType() {
      return binaryType;
    },
    set binaryType(value: BinaryType) {
      binaryType = value;
    },
    get onopen() {
      return onopen;
    },
    set onopen(value: WebSocket["onopen"]) {
      onopen = value;
    },
    get onmessage() {
      return onmessage;
    },
    set onmessage(value: WebSocket["onmessage"]) {
      onmessage = value;
    },
    get onerror() {
      return onerror;
    },
    set onerror(value: WebSocket["onerror"]) {
      onerror = value;
    },
    get onclose() {
      return onclose;
    },
    set onclose(value: WebSocket["onclose"]) {
      onclose = value;
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (readyState !== WebSocket.OPEN)
        throw new DOMException("Socket is not open", "InvalidStateError");
      const size =
        typeof data === "string"
          ? new TextEncoder().encode(data).byteLength
          : data instanceof Blob
            ? data.size
            : data.byteLength;
      if (size > maxBufferedAmount || bufferedAmount + size > maxBufferedAmount)
        throw new DOMException("Socket buffer limit exceeded", "QuotaExceededError");
      bufferedAmount += size;
      sends = sends
        .then(async () => {
          const payload =
            typeof data === "string"
              ? data
              : data instanceof Blob
                ? new Uint8Array(await data.arrayBuffer())
                : ArrayBuffer.isView(data)
                  ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                  : new Uint8Array(data);
          await bridge.sendLanTlsSocket({ id, data: payload });
        })
        .catch(() => dispatch(new Event("error")))
        .finally(() => {
          bufferedAmount -= size;
        });
    },
    close(code?: number, reason?: string) {
      if (readyState >= WebSocket.CLOSING) return;
      readyState = WebSocket.CLOSING;
      sends = sends
        .then(() =>
          bridge.closeLanTlsSocket({
            id,
            ...(code === undefined ? {} : { code }),
            ...(reason === undefined ? {} : { reason }),
          }),
        )
        .catch(() => dispatch(new Event("error")));
    },
  } as WebSocket;
  void bridge
    .openLanTlsSocket({ id, url, ...(protocols === undefined ? {} : { protocols }) })
    .catch(() => {
      readyState = WebSocket.CLOSED;
      unsubscribe();
      dispatch(new Event("error"));
      dispatch(new CloseEvent("close", { code: 1006 }));
    });
  return socket;
}

export const desktopWebSocketConstructor = (
  url: string,
  options?: Socket.WebSocketConstructorOptions,
): Socket.WebSocketLike => {
  if (options !== undefined && typeof options !== "string" && !Array.isArray(options))
    throw new TypeError("WebSocket headers are unsupported");
  return createDesktopWebSocket(url, options);
};
