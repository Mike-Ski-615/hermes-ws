import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";

import { MinimalWebSocket } from "../src/connection.ts";
import { OPCODE } from "../src/frame.ts";

const MASK = Buffer.from([1, 2, 3, 4]);

class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  ended = false;
  destroyed = false;

  write(data: Buffer): boolean {
    this.written.push(Buffer.from(data));
    return true;
  }

  end(): this {
    this.ended = true;
    this.emit("close");
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  feed(chunk: Buffer): void {
    this.emit("data", chunk);
  }
}

class DelayedCloseSocket extends FakeSocket {
  override end(): this {
    this.ended = true;
    queueMicrotask(() => {
      this.emit("close");
    });
    return this;
  }
}

function maskedFrame(
  opcode: number,
  payload: Buffer,
  { fin = true }: { fin?: boolean } = {},
): Buffer {
  const masked = Buffer.from(payload);

  for (let i = 0; i < masked.length; i++) {
    masked[i] ^= MASK[i % 4];
  }

  const header = Buffer.alloc(6);
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = 0x80 | payload.length;
  header.set(MASK, 2);

  return Buffer.concat([header, masked]);
}

function createConnection(maxPayload = 16 * 1024 * 1024) {
  const socket = new FakeSocket();
  const ws = new MinimalWebSocket(
    socket as unknown as Duplex,
    Buffer.alloc(0),
    maxPayload,
  );

  ws.on("error", () => {});

  return { socket, ws };
}

function closePayload(code: number, reason = ""): Buffer {
  const payload = Buffer.alloc(2 + reason.length);

  payload.writeUInt16BE(code, 0);
  Buffer.from(reason).copy(payload, 2);

  return payload;
}

describe("MinimalWebSocket messages", () => {
  test("emits text messages", () => {
    const { socket, ws } = createConnection();
    const messages: Array<{ data: unknown; isBinary: boolean }> = [];

    ws.on("message", (data, isBinary) => {
      messages.push({ data, isBinary });
    });

    socket.feed(maskedFrame(OPCODE.TEXT, Buffer.from("hello")));

    expect(messages).toEqual([{ data: "hello", isBinary: false }]);
  });

  test("emits binary messages", () => {
    const { socket, ws } = createConnection();
    const payload = Buffer.from([1, 2, 3]);
    const messages: Array<{ data: unknown; isBinary: boolean }> = [];

    ws.on("message", (data, isBinary) => {
      messages.push({ data, isBinary });
    });

    socket.feed(maskedFrame(OPCODE.BINARY, payload));

    expect(messages).toHaveLength(1);
    expect(messages[0].isBinary).toBe(true);
    expect((messages[0].data as Buffer).equals(payload)).toBe(true);
  });

  test("handles split frames", () => {
    const { socket, ws } = createConnection();
    const messages: string[] = [];
    const frame = maskedFrame(OPCODE.TEXT, Buffer.from("hello"));

    ws.on("message", (data) => {
      messages.push(String(data));
    });

    socket.feed(frame.subarray(0, 3));
    socket.feed(frame.subarray(3));

    expect(messages).toEqual(["hello"]);
  });

  test("handles multiple frames in one chunk", () => {
    const { socket, ws } = createConnection();
    const messages: string[] = [];

    ws.on("message", (data) => {
      messages.push(String(data));
    });

    socket.feed(
      Buffer.concat([
        maskedFrame(OPCODE.TEXT, Buffer.from("foo")),
        maskedFrame(OPCODE.TEXT, Buffer.from("bar")),
      ]),
    );

    expect(messages).toEqual(["foo", "bar"]);
  });

  test("send writes a text frame", () => {
    const { socket, ws } = createConnection();

    ws.send("hello");

    expect(socket.written[0][0]).toBe(0x81);
    expect(socket.written[0].subarray(2).toString()).toBe("hello");
  });

  test("send writes a binary frame", () => {
    const { socket, ws } = createConnection();
    const payload = Buffer.from([1, 2, 3]);

    ws.send(payload);

    expect(socket.written[0][0]).toBe(0x82);
    expect(socket.written[0].subarray(2).equals(payload)).toBe(true);
  });

  test("initialData with a full frame emits a message", async () => {
    const socket = new FakeSocket();
    const ws = new MinimalWebSocket(
      socket as unknown as Duplex,
      maskedFrame(OPCODE.TEXT, Buffer.from("early")),
    );
    const messages: string[] = [];

    ws.on("message", (data) => {
      messages.push(String(data));
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(messages).toEqual(["early"]);
  });
});

describe("MinimalWebSocket control frames", () => {
  test("replies to ping with pong", () => {
    const { socket, ws } = createConnection();

    ws.on("pong", () => {});

    socket.feed(maskedFrame(OPCODE.PING, Buffer.from("ab")));

    expect(socket.written[0][0]).toBe(0x8a);
    expect(socket.written[0].subarray(2).toString()).toBe("ab");
  });

  test("emits pong events", () => {
    const { socket, ws } = createConnection();
    const pongs: Buffer[] = [];

    ws.on("pong", (data) => {
      pongs.push(data);
    });

    socket.feed(maskedFrame(OPCODE.PONG, Buffer.from("cd")));

    expect(pongs[0].toString()).toBe("cd");
  });

  test("rejects ping payload over 125 bytes", () => {
    const { ws } = createConnection();

    expect(() => ws.ping(Buffer.alloc(126))).toThrow(
      "Ping 负载不能超过 125 字节",
    );
  });

  test("rejects pong payload over 125 bytes", () => {
    const { ws } = createConnection();

    expect(() => ws.pong(Buffer.alloc(126))).toThrow(
      "Pong 负载不能超过 125 字节",
    );
  });
});

describe("MinimalWebSocket limits", () => {
  test("send rejects payload over maxPayload", () => {
    const { ws } = createConnection(10);

    expect(() => ws.send(Buffer.alloc(11))).toThrow("消息过大");
  });

  test("close rejects invalid code", () => {
    const { ws } = createConnection();

    expect(() => ws.close(999)).toThrow("无效的关闭代码");
  });

  test("close rejects reason over 123 bytes", () => {
    const { ws } = createConnection();

    expect(() => ws.close(1000, "x".repeat(124))).toThrow(
      "关闭原因不能超过 123 字节",
    );
  });

  test("maxPayload boundary allows 9 and 10 but rejects 11", () => {
    const { ws } = createConnection(10);

    expect(() => ws.send(Buffer.alloc(9))).not.toThrow();
    expect(() => ws.send(Buffer.alloc(10))).not.toThrow();
    expect(() => ws.send(Buffer.alloc(11))).toThrow("消息过大");
  });
});

describe("MinimalWebSocket state", () => {
  test("normal close path", () => {
    const { socket, ws } = createConnection();
    let closeCode = 0;
    let closeReason = "";

    ws.on("close", (code, reason) => {
      closeCode = code;
      closeReason = reason.toString();
    });

    socket.feed(maskedFrame(OPCODE.CLOSE, closePayload(1000, "bye")));

    expect(closeCode).toBe(1000);
    expect(closeReason).toBe("bye");
    expect(socket.ended).toBe(true);
    expect(ws.readyState).toBe(MinimalWebSocket.CLOSED);
  });

  test("readyState moves from OPEN to CLOSING to CLOSED", async () => {
    const socket = new DelayedCloseSocket();
    const ws = new MinimalWebSocket(socket as unknown as Duplex);

    expect(ws.readyState).toBe(MinimalWebSocket.OPEN);

    ws.close(1000, "ok");

    expect(ws.readyState).toBe(MinimalWebSocket.CLOSING);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ws.readyState).toBe(MinimalWebSocket.CLOSED);
  });

  test("destroy moves to CLOSED", () => {
    const { socket, ws } = createConnection();

    ws.destroy();

    expect(socket.destroyed).toBe(true);
    expect(ws.readyState).toBe(MinimalWebSocket.CLOSED);
  });

  test("closed connection does not write on send/ping/pong/close", () => {
    const { socket, ws } = createConnection();

    ws.destroy();

    const before = socket.written.length;

    ws.send("x");
    ws.ping();
    ws.pong();
    ws.close();

    expect(socket.written.length).toBe(before);
  });
});

describe("MinimalWebSocket protocol errors", () => {
  test("TEXT FIN=0 closes with 1002", () => {
    const { socket, ws } = createConnection();
    let closeCode = 0;

    ws.on("close", (code) => {
      closeCode = code;
    });

    socket.feed(
      maskedFrame(OPCODE.TEXT, Buffer.from("x"), { fin: false }),
    );

    expect(closeCode).toBe(1002);
  });

  test("BINARY FIN=0 closes with 1002", () => {
    const { socket, ws } = createConnection();
    let closeCode = 0;

    ws.on("close", (code) => {
      closeCode = code;
    });

    socket.feed(
      maskedFrame(OPCODE.BINARY, Buffer.from("x"), { fin: false }),
    );

    expect(closeCode).toBe(1002);
  });

  test("invalid text UTF-8 closes with 1007", () => {
    const { socket, ws } = createConnection();
    let closeCode = 0;

    ws.on("close", (code) => {
      closeCode = code;
    });

    socket.feed(maskedFrame(OPCODE.TEXT, Buffer.from([0xff])));

    expect(closeCode).toBe(1007);
  });

  test("unmasked frame closes with 1002", () => {
    const { socket, ws } = createConnection();
    let closeCode = 0;

    ws.on("close", (code) => {
      closeCode = code;
    });

    socket.feed(Buffer.from([0x81, 0x01, 0x61]));

    expect(closeCode).toBe(1002);
  });

  test("invalid close code closes with 1002", () => {
    const { socket, ws } = createConnection();
    let closeCode = 0;

    ws.on("close", (code) => {
      closeCode = code;
    });

    socket.feed(maskedFrame(OPCODE.CLOSE, closePayload(999)));

    expect(closeCode).toBe(1002);
  });

  test("invalid close reason UTF-8 closes with 1007", () => {
    const { socket, ws } = createConnection();
    let closeCode = 0;
    const payload = Buffer.from([0x03, 0xe8, 0xff]);

    ws.on("close", (code) => {
      closeCode = code;
    });

    socket.feed(maskedFrame(OPCODE.CLOSE, payload));

    expect(closeCode).toBe(1007);
  });

  test("payload over maxPayload closes with 1009", () => {
    const { socket, ws } = createConnection(10);
    let closeCode = 0;

    ws.on("close", (code) => {
      closeCode = code;
    });

    socket.feed(maskedFrame(OPCODE.TEXT, Buffer.alloc(11)));

    expect(closeCode).toBe(1009);
  });
});
