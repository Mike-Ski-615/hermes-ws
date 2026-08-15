// hermes-ws/src/client.ts

type Listener = (...args: any[]) => void;

export interface HermesClientOptions {
  autoConnect?: boolean;
  path?: string;
  WebSocket?: typeof WebSocket;
}

export interface HermesClient {
  readonly readyState: number;
  connect(): void;
  emit(event: string, data?: unknown): this;
  on(event: string, listener: Listener): this;
  once(event: string, listener: Listener): this;
  off(event: string, listener?: Listener): this;
  close(code?: number, reason?: string): void;
}

function resolveUrl(url: string, path: string): string {
  const parsed = new URL(url);

  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";

  if (!parsed.pathname.endsWith(path)) {
    parsed.pathname = parsed.pathname.replace(/\/$/, "") + path;
  }

  return parsed.toString();
}

export function io(
  url: string,
  options: HermesClientOptions = {},
): HermesClient {
  const autoConnect = options.autoConnect !== false;
  const path = options.path ?? "/ws";
  const WebSocketImpl = options.WebSocket ?? WebSocket;
  const socketUrl = resolveUrl(url, path);

  let ws: WebSocket | null = null;
  const listeners = new Map<string, Set<Listener>>();
  const pending: Array<{ event: string; data?: unknown }> = [];

  function emitLocal(event: string, ...args: unknown[]): void {
    const set = listeners.get(event);

    if (!set) return;

    for (const listener of [...set]) {
      listener(...args);
    }
  }

  function send(event: string, data?: unknown): void {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event, data }));
    }
  }

  function connect(): void {
    if (
      ws &&
      (ws.readyState === WebSocket.CONNECTING ||
        ws.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    ws = new WebSocketImpl(socketUrl);

    ws.onopen = () => {
      const queued = pending.splice(0);

      for (const item of queued) {
        send(item.event, item.data);
      }

      emitLocal("connect");
    };

    ws.onmessage = (event) => {
      const raw = event.data;

      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);

          if (parsed && typeof parsed.event === "string") {
            emitLocal(parsed.event, parsed.data);
            return;
          }
        } catch {
          // fall through to raw message
        }

        emitLocal("message", raw);
        return;
      }

      emitLocal("message", raw);
    };

    ws.onclose = (event) => {
      emitLocal("disconnect", event.reason || String(event.code));
    };

    ws.onerror = (event) => {
      emitLocal("error", event);
    };
  }

  const client: HermesClient = {
    get readyState() {
      return ws?.readyState ?? WebSocket.CLOSED;
    },

    connect() {
      connect();
    },

    emit(event, data) {
      if (ws?.readyState === WebSocket.OPEN) {
        send(event, data);
      } else {
        pending.push({ event, data });
      }

      return this;
    },

    on(event, listener) {
      let set = listeners.get(event);

      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }

      set.add(listener);

      return this;
    },

    once(event, listener) {
      const wrapper = (...args: unknown[]) => {
        this.off(event, wrapper as Listener);
        listener(...args);
      };

      return this.on(event, wrapper as Listener);
    },

    off(event, listener) {
      if (!listener) {
        listeners.delete(event);
        return this;
      }

      listeners.get(event)?.delete(listener);

      return this;
    },

    close(code, reason) {
      ws?.close(code, reason);
    },
  };

  if (autoConnect) {
    connect();
  }

  return client;
}
