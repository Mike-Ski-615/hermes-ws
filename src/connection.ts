// hermes-ws/connection.ts
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";

import {
  decodeFrame,
  encodeFrame,
  getFrameLength,
  OPCODE,
  type Frame,
} from "./frame.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_PAYLOAD = 16 * 1024 * 1024;

function truncateReason(message: string, maxBytes = 123): string {
  let result = "";
  let bytes = 0;

  for (const char of message) {
    const size = Buffer.byteLength(char);

    if (bytes + size > maxBytes) break;

    result += char;
    bytes += size;
  }

  return result;
}

function isValidCloseCode(code: number): boolean {
  return (
    (code >= 1000 &&
      code <= 1014 &&
      code !== 1004 &&
      code !== 1005 &&
      code !== 1006) ||
    (code >= 3000 && code <= 4999)
  );
}

function validateClose(code: number, reason: string): Buffer {
  if (!isValidCloseCode(code)) {
    throw new RangeError(`无效的关闭代码: ${code}`);
  }

  const reasonBuffer = Buffer.from(reason);

  if (reasonBuffer.length > 123) {
    throw new RangeError("关闭原因不能超过 123 字节");
  }

  try {
    utf8Decoder.decode(reasonBuffer);
  } catch {
    throw new TypeError("关闭原因不是合法 UTF-8");
  }

  const payload = Buffer.alloc(2 + reasonBuffer.length);

  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);

  return payload;
}

export class MinimalWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = MinimalWebSocket.CONNECTING;
  readonly OPEN = MinimalWebSocket.OPEN;
  readonly CLOSING = MinimalWebSocket.CLOSING;
  readonly CLOSED = MinimalWebSocket.CLOSED;

  readyState: 0 | 1 | 2 | 3 = MinimalWebSocket.OPEN;

  private buffer = Buffer.alloc(0);
  private readonly socket: Duplex;
  private readonly maxPayload: number;
  private closeEmitted = false;
  private lastCloseCode = 1006;
  private lastCloseReason = Buffer.alloc(0);

  constructor(
    socket: Duplex,
    initialData: Buffer = Buffer.alloc(0),
    maxPayload = MAX_PAYLOAD,
  ) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.buffer = Buffer.from(initialData);

    socket.on("data", (chunk) => {
      this.onData(chunk);
    });

    socket.on("error", (error) => {
      this.emit("error", error);
    });

    socket.on("close", () => {
      this.onSocketClose();
    });

    if (this.buffer.length > 0) {
      queueMicrotask(() => {
        this.processBuffer();
      });
    }
  }

  send(data: string | Buffer): void {
    if (this.readyState !== MinimalWebSocket.OPEN) return;

    const opcode = typeof data === "string" ? OPCODE.TEXT : OPCODE.BINARY;
    const payload = typeof data === "string" ? Buffer.from(data) : data;

    if (payload.length > this.maxPayload) {
      throw new RangeError("消息过大");
    }

    this.writeFrame(opcode, payload);
  }

  ping(data: Buffer = Buffer.alloc(0)): void {
    if (data.length > 125) {
      throw new RangeError("Ping 负载不能超过 125 字节");
    }

    if (this.readyState !== MinimalWebSocket.OPEN) return;

    this.writeFrame(OPCODE.PING, data);
  }

  pong(data: Buffer = Buffer.alloc(0)): void {
    if (data.length > 125) {
      throw new RangeError("Pong 负载不能超过 125 字节");
    }

    if (this.readyState !== MinimalWebSocket.OPEN) return;

    this.writeFrame(OPCODE.PONG, data);
  }

  close(code = 1000, reason = ""): void {
    if (
      this.readyState === MinimalWebSocket.CLOSING ||
      this.readyState === MinimalWebSocket.CLOSED
    ) {
      return;
    }

    const payload = validateClose(code, reason);

    this.readyState = MinimalWebSocket.CLOSING;
    this.lastCloseCode = code;
    this.lastCloseReason = Buffer.from(reason);

    this.writeFrame(OPCODE.CLOSE, payload);
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.processBuffer();
  }

  private processBuffer(): void {
    while (true) {
      let frameLength: number;

      try {
        frameLength = getFrameLength(this.buffer, this.maxPayload);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("帧未完整")
        ) {
          return;
        }

        const message =
          error instanceof Error ? error.message : "无效帧";

        this.protocolError(
          message,
          message.startsWith("消息过大") ? 1009 : 1002,
        );
        return;
      }

      if (this.buffer.length < frameLength) return;

      const frameBuffer = this.buffer.subarray(0, frameLength);
      this.buffer = this.buffer.subarray(frameLength);

      let frame: Frame;

      try {
        frame = decodeFrame(frameBuffer, this.maxPayload);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "无效帧";

        this.protocolError(
          message,
          message.startsWith("消息过大") ? 1009 : 1002,
        );
        return;
      }

      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: Frame): void {
    switch (frame.opcode) {
      case OPCODE.TEXT: {
        let text: string;

        try {
          text = utf8Decoder.decode(frame.payload);
        } catch {
          this.protocolError("文本帧 UTF-8 编码无效", 1007);
          return;
        }

        this.emit("message", text, false);
        return;
      }

      case OPCODE.BINARY:
        this.emit("message", frame.payload, true);
        return;

      case OPCODE.PING:
        this.pong(frame.payload);
        return;

      case OPCODE.PONG:
        this.emit("pong", frame.payload);
        return;

      case OPCODE.CLOSE:
        this.handleCloseFrame(frame.payload);
        return;

      default:
        this.protocolError(`未处理的操作码：${frame.opcode}`);
    }
  }

  private handleCloseFrame(payload: Buffer): void {
    if (this.readyState !== MinimalWebSocket.OPEN) return;

    if (
      payload.length === 1 ||
      (payload.length >= 2 && !isValidCloseCode(payload.readUInt16BE(0)))
    ) {
      this.protocolError("无效的关闭帧负载", 1002);
      return;
    }

    const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
    const reason =
      payload.length >= 2 ? Buffer.from(payload.subarray(2)) : Buffer.alloc(0);

    if (reason.length > 0) {
      try {
        utf8Decoder.decode(reason);
      } catch {
        this.protocolError("关闭原因不是合法 UTF-8", 1007);
        return;
      }
    }

    const reply =
      payload.length === 0
        ? Buffer.alloc(0)
        : validateClose(code, reason.toString("utf8"));

    this.readyState = MinimalWebSocket.CLOSING;
    this.lastCloseCode = code;
    this.lastCloseReason = reason;

    this.writeFrame(OPCODE.CLOSE, reply);
    this.socket.end();
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    this.socket.write(encodeFrame(opcode, payload));
  }

  private protocolError(message: string, code = 1002): void {
    this.emit("error", new Error(message));
    this.close(code, truncateReason(message));
  }

  private emitClose(code: number, reason: Buffer): void {
    if (this.closeEmitted) return;

    this.closeEmitted = true;
    this.readyState = MinimalWebSocket.CLOSED;
    this.emit("close", code, reason);
  }

  private onSocketClose(): void {
    this.emitClose(this.lastCloseCode, this.lastCloseReason);
  }
}
