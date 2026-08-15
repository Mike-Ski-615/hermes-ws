// hermes-ws/server.ts
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { MinimalWebSocket } from "./connection.js";
import { sendHandshake } from "./handshake.js";
import type { MinimalWebSocketServerOptions } from "./types.js";

const keyRegex = /^[+/0-9A-Za-z]{22}==$/;

export class MinimalWebSocketServer extends EventEmitter {
  clients = new Set<MinimalWebSocket>();
  private readonly maxPayload: number;
  private closed = false;

  constructor(options: MinimalWebSocketServerOptions = {}) {
    super();

    const maxPayload = options.maxPayload ?? 16 * 1024 * 1024;

    if (!Number.isSafeInteger(maxPayload) || maxPayload <= 0) {
      throw new RangeError("maxPayload 必须是正整数");
    }

    this.maxPayload = maxPayload;
  }

  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: MinimalWebSocket, request: IncomingMessage) => void,
  ): void {
    if (this.closed) {
      socket.destroy();
      return;
    }

    const key = request.headers["sec-websocket-key"];

    if (typeof key !== "string" || !keyRegex.test(key)) {
      socket.destroy();
      return;
    }

    if (request.headers["sec-websocket-version"] !== "13") {
      socket.destroy();
      return;
    }

    const upgrade = request.headers.upgrade?.toLowerCase();
    const connection = request.headers.connection?.toLowerCase();

    if (
      upgrade !== "websocket" ||
      !connection?.split(",").some((value) => value.trim() === "upgrade")
    ) {
      socket.destroy();
      return;
    }

    sendHandshake(socket, key);

    const ws = new MinimalWebSocket(socket, head, this.maxPayload);

    this.clients.add(ws);
    ws.on("close", () => {
      this.clients.delete(ws);
    });

    callback(ws, request);
  }

  broadcast(data: string | Buffer, exclude?: MinimalWebSocket): void {
    for (const client of this.clients) {
      if (client === exclude) continue;

      client.send(data);
    }
  }

  close(callback?: (err?: Error) => void): void {
    if (this.closed) {
      callback?.();
      return;
    }

    this.closed = true;

    const clients = [...this.clients];

    if (clients.length === 0) {
      this.emit("close");
      callback?.();
      return;
    }

    let remaining = clients.length;

    const done = () => {
      remaining -= 1;

      if (remaining === 0) {
        this.emit("close");
        callback?.();
      }
    };

    for (const client of clients) {
      client.once("close", done);
      client.destroy();
    }
  }
}
