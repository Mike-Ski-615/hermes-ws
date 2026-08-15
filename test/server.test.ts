import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { MinimalWebSocket } from "../src/connection.ts";
import { MinimalWebSocketServer } from "../src/server.ts";

const KEY = "dGhlIHNhbXBsZSBub25jZQ==";

class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  destroyed = false;

  write(data: Buffer): boolean {
    this.written.push(Buffer.from(data));
    return true;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

function request(overrides: Record<string, unknown> = {}): IncomingMessage {
  return {
    headers: {
      "sec-websocket-key": KEY,
      "sec-websocket-version": "13",
      upgrade: "websocket",
      connection: "upgrade",
      ...overrides,
    },
  } as IncomingMessage;
}

function framePayload(frame: Buffer): string {
  const length = frame[1] & 0x7f;

  return frame.subarray(2, 2 + length).toString();
}

function connect(server: MinimalWebSocketServer) {
  const socket = new FakeSocket();
  let ws: MinimalWebSocket | undefined;

  server.handleUpgrade(
    request(),
    socket as unknown as Duplex,
    Buffer.alloc(0),
    (connected) => {
      ws = connected;
    },
  );

  return { socket, ws };
}

describe("MinimalWebSocketServer handshake", () => {
  test("accepts a valid upgrade", () => {
    const server = new MinimalWebSocketServer();
    const { socket, ws } = connect(server);

    expect(socket.written[0].toString()).toContain(
      "HTTP/1.1 101 Switching Protocols",
    );
    expect(server.clients.has(ws!)).toBe(true);
  });

  test("rejects invalid maxPayload", () => {
    expect(() => new MinimalWebSocketServer({ maxPayload: -1 })).toThrow(
      "maxPayload 必须是正整数",
    );
    expect(() => new MinimalWebSocketServer({ maxPayload: 1.5 })).toThrow(
      "maxPayload 必须是正整数",
    );
  });

  test("rejects missing or invalid handshake headers", () => {
    const cases = [
      { "sec-websocket-key": undefined },
      { "sec-websocket-version": "12" },
      { upgrade: undefined },
      { connection: undefined },
    ];

    for (const headers of cases) {
      const server = new MinimalWebSocketServer();
      const socket = new FakeSocket();

      server.handleUpgrade(
        request(headers),
        socket as unknown as Duplex,
        Buffer.alloc(0),
        () => {},
      );

      expect(socket.destroyed).toBe(true);
    }
  });
});

describe("MinimalWebSocketServer lifecycle", () => {
  test("duplicate close only emits once", () => {
    const server = new MinimalWebSocketServer();
    let closeCount = 0;

    server.on("close", () => {
      closeCount += 1;
    });

    server.close(() => {});
    server.close(() => {});

    expect(closeCount).toBe(1);
  });

  test("rejects upgrades after close", () => {
    const server = new MinimalWebSocketServer();
    const socket = new FakeSocket();

    server.close(() => {});
    server.handleUpgrade(
      request(),
      socket as unknown as Duplex,
      Buffer.alloc(0),
      () => {},
    );

    expect(socket.destroyed).toBe(true);
  });
});

describe("MinimalWebSocketServer broadcast", () => {
  test("broadcast excludes the sender", () => {
    const server = new MinimalWebSocketServer();
    const a = connect(server);
    const b = connect(server);

    server.broadcast("hello all", a.ws);

    expect(a.socket.written).toHaveLength(1);
    expect(framePayload(b.socket.written[1])).toBe("hello all");
  });

  test("broadcast sends to everyone", () => {
    const server = new MinimalWebSocketServer();
    const a = connect(server);
    const b = connect(server);

    server.broadcast("everyone");

    expect(framePayload(a.socket.written[1])).toBe("everyone");
    expect(framePayload(b.socket.written[1])).toBe("everyone");
  });

  test("broadcast skips closed clients", () => {
    const server = new MinimalWebSocketServer();
    const a = connect(server);
    const b = connect(server);

    a.socket.destroy();

    expect(() => server.broadcast("still open")).not.toThrow();
    expect(framePayload(b.socket.written[1])).toBe("still open");
  });

  test("close terminates all clients", () => {
    const server = new MinimalWebSocketServer();
    const a = connect(server);
    const b = connect(server);

    server.close(() => {});

    expect(a.socket.destroyed).toBe(true);
    expect(b.socket.destroyed).toBe(true);
    expect(server.clients.size).toBe(0);
  });
});
