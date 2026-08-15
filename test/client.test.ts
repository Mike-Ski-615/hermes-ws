import { describe, expect, test } from "bun:test";

import { io } from "../src/client.ts";

const instances: FakeWebSocket[] = [];

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(data: string): void {
    this.onmessage?.({ data });
  }
}

function createSocket(autoConnect = true) {
  const socket = io("http://localhost:3000", {
    autoConnect,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
  });

  return { socket, ws: instances.at(-1)! };
}

describe("hermes-ws client", () => {
  test("autoConnect creates a socket and emits connect", () => {
    const before = instances.length;
    const { socket, ws } = createSocket();
    let connected = false;

    socket.on("connect", () => {
      connected = true;
    });

    expect(instances.length).toBe(before + 1);
    expect(ws.url).toBe("ws://localhost:3000/ws");

    ws.open();

    expect(connected).toBe(true);
  });

  test("emit before open queues and flushes on connect", () => {
    const { socket } = createSocket(false);

    socket.emit("chat", { text: "hello" });
    socket.connect();

    const ws = instances.at(-1)!;

    expect(ws.sent).toHaveLength(0);

    ws.open();

    expect(JSON.parse(ws.sent[0])).toEqual({
      event: "chat",
      data: { text: "hello" },
    });
  });

  test("parses JSON events from the server", () => {
    const { socket, ws } = createSocket();
    const events: unknown[] = [];

    socket.on("chat", (data) => {
      events.push(data);
    });

    ws.open();
    ws.receive(JSON.stringify({ event: "chat", data: "echo: hello" }));

    expect(events).toEqual(["echo: hello"]);
  });

  test("once only fires one time", () => {
    const { socket, ws } = createSocket();
    let count = 0;

    socket.once("chat", () => {
      count += 1;
    });

    ws.open();
    ws.receive(JSON.stringify({ event: "chat", data: 1 }));
    ws.receive(JSON.stringify({ event: "chat", data: 2 }));

    expect(count).toBe(1);
  });

  test("off removes listeners", () => {
    const { socket, ws } = createSocket();
    const calls: unknown[] = [];
    const listener = (data: unknown) => {
      calls.push(data);
    };

    socket.on("chat", listener);
    socket.off("chat", listener);

    ws.open();
    ws.receive(JSON.stringify({ event: "chat", data: 1 }));

    expect(calls).toHaveLength(0);
  });

  test("close calls WebSocket close", () => {
    const { socket, ws } = createSocket();
    let closed = false;

    ws.onclose = () => {
      closed = true;
    };

    socket.close(1000, "bye");

    expect(closed).toBe(true);
  });
});
