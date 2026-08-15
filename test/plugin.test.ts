import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { ViteDevServer } from "vite";

import { MinimalWebSocket } from "../src/connection.ts";
import { MinimalWebSocketServer } from "../src/server.ts";
import { hermesWs } from "../src/plugin.ts";

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

function request(url: string): IncomingMessage {
  return {
    url,
    headers: {
      "sec-websocket-key": KEY,
      "sec-websocket-version": "13",
      upgrade: "websocket",
      connection: "upgrade",
    },
  } as IncomingMessage;
}

function setupPlugin() {
  const httpServer = new EventEmitter();
  const server = { httpServer } as unknown as ViteDevServer;
  let connectedWs: MinimalWebSocket | undefined;
  let connectedWss: MinimalWebSocketServer | undefined;

  const plugin = hermesWs({
    path: "/ws",
    onConnection(ws, wss) {
      connectedWs = ws;
      connectedWss = wss;
    },
  });

  const configureServer = plugin.configureServer as (
    server: ViteDevServer,
  ) => void;

  configureServer(server);

  return {
    httpServer,
    connectedWs: () => connectedWs,
    connectedWss: () => connectedWss,
  };
}

describe("hermes-ws plugin", () => {
  test("handles /ws and calls onConnection", () => {
    const { httpServer, connectedWs, connectedWss } = setupPlugin();
    const socket = new FakeSocket();

    httpServer.emit(
      "upgrade",
      request("/ws"),
      socket,
      Buffer.alloc(0),
    );

    expect(socket.written[0].toString()).toContain(
      "HTTP/1.1 101 Switching Protocols",
    );
    expect(connectedWs()).toBeDefined();
    expect(connectedWss()).toBeDefined();
  });

  test("leaves non-/ws upgrades untouched", () => {
    const { httpServer } = setupPlugin();
    const socket = new FakeSocket();

    httpServer.emit(
      "upgrade",
      request("/other"),
      socket,
      Buffer.alloc(0),
    );

    expect(socket.written).toHaveLength(0);
    expect(socket.destroyed).toBe(false);
  });

  test("closes clients when vite closes", () => {
    const { httpServer } = setupPlugin();
    const socket = new FakeSocket();

    httpServer.emit(
      "upgrade",
      request("/ws"),
      socket,
      Buffer.alloc(0),
    );

    expect(socket.destroyed).toBe(false);

    httpServer.emit("close");

    expect(socket.destroyed).toBe(true);
  });
});
