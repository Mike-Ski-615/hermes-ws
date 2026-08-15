import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { connect, createServer as createNetServer } from "node:net";

import { MinimalWebSocketServer } from "../src/server.ts";

const KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const MASK = Buffer.from([1, 2, 3, 4]);

function maskedFrame(opcode: number, payload: Buffer): Buffer {
  const masked = Buffer.from(payload);

  for (let i = 0; i < masked.length; i++) {
    masked[i] ^= MASK[i % 4];
  }

  const header = Buffer.alloc(6);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | payload.length;
  header.set(MASK, 2);

  return Buffer.concat([header, masked]);
}

function closePayload(code: number, reason: string): Buffer {
  const payload = Buffer.alloc(2 + reason.length);

  payload.writeUInt16BE(code, 0);
  Buffer.from(reason).copy(payload, 2);

  return payload;
}

describe("integration", () => {
  test("real tcp server + raw tcp client", async () => {
    const wss = new MinimalWebSocketServer();

    let resolvePong!: () => void;
    const pongReceived = new Promise<void>((resolve) => {
      resolvePong = resolve;
    });

    let resolveServerClose!: () => void;
    const serverClosed = new Promise<void>((resolve) => {
      resolveServerClose = resolve;
    });

    wss.on("connection", (ws) => {
      ws.on("error", () => {});
      ws.on("pong", () => {
        resolvePong();
      });
      ws.on("close", () => {
        resolveServerClose();
      });
      ws.on("message", (message: string | Buffer, isBinary: boolean) => {
        if (isBinary) {
          ws.send(message as Buffer);
        } else {
          ws.send("hello client");
        }
      });

      ws.ping(Buffer.from("ping"));
    });

    const netServer = createNetServer((socket) => {
      let buffer = Buffer.alloc(0);

      socket.on("data", (data) => {
        buffer = Buffer.concat([buffer, data]);

        const marker = buffer.indexOf("\r\n\r\n");

        if (marker === -1) return;

        const head = buffer.subarray(0, marker).toString();
        const keyMatch = /Sec-WebSocket-Key: (.+)\r\n/i.exec(head);
        const request = {
          url: "/ws",
          headers: {
            "sec-websocket-key": keyMatch?.[1].trim() ?? "",
            "sec-websocket-version": "13",
            upgrade: "websocket",
            connection: "upgrade",
          },
        } as IncomingMessage;

        wss.handleUpgrade(request, socket, Buffer.alloc(0), (ws) => {
          wss.emit("connection", ws, request);
        });

        buffer = Buffer.alloc(0);
      });
    });

    await new Promise<void>((resolve) => {
      netServer.listen(0, "127.0.0.1", resolve);
    });

    const address = netServer.address();

    if (!address || typeof address === "string") {
      throw new Error("failed to get server address");
    }

    const socket = connect(address.port, "127.0.0.1");
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const frameWaiters: Array<(frame: { opcode: number; payload: Buffer }) => void> =
      [];

    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);

      if (!upgraded) {
        const marker = buffer.indexOf("\r\n\r\n");

        if (marker === -1) return;

        if (!buffer.subarray(0, marker).toString().includes("101")) {
          throw new Error("handshake did not return 101");
        }

        upgraded = true;
        buffer = buffer.subarray(marker + 4);
      }

      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        const length = buffer[1] & 0x7f;

        if (buffer.length < 2 + length) break;

        const payload = buffer.subarray(2, 2 + length);
        buffer = buffer.subarray(2 + length);

        const waiter = frameWaiters.shift();

        if (waiter) {
          waiter({ opcode, payload });
        }
      }
    });

    const nextFrame = () =>
      new Promise<{ opcode: number; payload: Buffer }>((resolve) => {
        frameWaiters.push(resolve);
      });

    socket.write(
      "GET /ws HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${address.port}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${KEY}\r\n` +
        "Sec-WebSocket-Version: 13\r\n\r\n",
    );

    const pingFrame = await nextFrame();

    expect(pingFrame.opcode).toBe(0x9);
    expect(pingFrame.payload.toString()).toBe("ping");

    socket.write(maskedFrame(0xa, Buffer.from("ping")));
    await pongReceived;

    socket.write(maskedFrame(0x1, Buffer.from("hello")));

    const textFrame = await nextFrame();

    expect(textFrame.opcode).toBe(0x1);
    expect(textFrame.payload.toString()).toBe("hello client");

    socket.write(maskedFrame(0x2, Buffer.from([1, 2, 3])));

    const binaryFrame = await nextFrame();

    expect(binaryFrame.opcode).toBe(0x2);
    expect(binaryFrame.payload.equals(Buffer.from([1, 2, 3]))).toBe(true);

    socket.write(maskedFrame(0x8, closePayload(1000, "bye")));

    const closeFrame = await nextFrame();

    expect(closeFrame.opcode).toBe(0x8);
    expect(closeFrame.payload.readUInt16BE(0)).toBe(1000);
    expect(closeFrame.payload.subarray(2).toString()).toBe("bye");

    await serverClosed;

    socket.destroy();
    wss.close(() => {});

    await new Promise<void>((resolve) => {
      netServer.close(() => resolve());
    });
  });
});
