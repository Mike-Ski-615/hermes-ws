// hermes-ws/frame.ts
// WebSocket 帧结构（RFC 6455 5.2）
//
//  0                   1                   2                   3
//  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-------+-+-------------+-------------------------------+
// |F|R|R|R| opcode|M| Payload len |    Extended payload length    |
// |I|S|S|S|  (4)  |A|     (7)     |             (16/64)           |
// |N|V|V|V|       |S|             |                               |
// +-+-+-+-+-------+-+-------------+-------------------------------+
//
// 客户端 -> 服务端：MASK 必须为 1，payload 用 4 字节 mask 异或。
// 服务端 -> 客户端：MASK 必须为 0。

export const OPCODE = {
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

const CONTROL_OPCODES = new Set<number>([
  OPCODE.CLOSE,
  OPCODE.PING,
  OPCODE.PONG,
]);

const SUPPORTED_OPCODES = new Set<number>([
  OPCODE.TEXT,
  OPCODE.BINARY,
  OPCODE.CLOSE,
  OPCODE.PING,
  OPCODE.PONG,
]);

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

interface FrameHeader {
  fin: boolean;
  rsv: number;
  opcode: number;
  masked: boolean;
  payloadLength: number;
  headerLength: number;
}

const MAX_SAFE_INTEGER = 9_007_199_254_740_991n;

function parseFrameHeader(buffer: Buffer): FrameHeader {
  if (buffer.length < 2) {
    throw new Error("帧未完整：帧头不完整");
  }

  const first = buffer[0];
  const second = buffer[1];
  const length7 = second & 0x7f;

  let offset = 2;
  let payloadLength: number;

  if (length7 === 126) {
    if (buffer.length < 4) {
      throw new Error("帧未完整：扩展长度不完整");
    }

    payloadLength = buffer.readUInt16BE(2);
    offset += 2;
  } else if (length7 === 127) {
    if (buffer.length < 10) {
      throw new Error("帧未完整：扩展长度不完整");
    }

    const bigLength = buffer.readBigUInt64BE(2);

    if (bigLength > MAX_SAFE_INTEGER) {
      throw new Error("负载过大：负载长度超过安全整数范围");
    }

    payloadLength = Number(bigLength);
    offset += 8;
  } else {
    payloadLength = length7;
  }

  if ((second & 0x80) !== 0) {
    if (buffer.length < offset + 4) {
      throw new Error("帧未完整：掩码不完整");
    }

    offset += 4;
  }

  return {
    fin: (first & 0x80) !== 0,
    rsv: first & 0x70,
    opcode: first & 0x0f,
    masked: (second & 0x80) !== 0,
    payloadLength,
    headerLength: offset,
  };
}

function validateFrameHeader(header: FrameHeader, maxPayload: number): void {
  if (
    (header.opcode === OPCODE.TEXT || header.opcode === OPCODE.BINARY) &&
    !header.fin
  ) {
    throw new Error("当前不支持消息分片：数据帧必须 FIN=1");
  }

  if (
    CONTROL_OPCODES.has(header.opcode) &&
    (!header.fin || header.payloadLength > 125)
  ) {
    throw new Error("控制帧必须 FIN=1 且负载不超过 125 字节");
  }

  if (maxPayload > 0 && header.payloadLength > maxPayload) {
    throw new Error("消息过大：负载长度超过限制");
  }
}

function assertSupportedOpcode(header: FrameHeader): void {
  if (!SUPPORTED_OPCODES.has(header.opcode)) {
    throw new Error(`暂不支持的操作码：${header.opcode}`);
  }
}

export function getFrameLength(buffer: Buffer, maxPayload = 0): number {
  const header = parseFrameHeader(buffer);
  assertSupportedOpcode(header);

  if (header.rsv !== 0) {
    throw new Error("不支持的扩展：RSV 位已设置，但当前不支持扩展");
  }

  validateFrameHeader(header, maxPayload);

  return header.headerLength + header.payloadLength;
}

export function decodeFrame(buffer: Buffer, maxPayload = 0): Frame {
  const header = parseFrameHeader(buffer);
  assertSupportedOpcode(header);

  if (header.rsv !== 0) {
    throw new Error("不支持的扩展：RSV 位已设置，但当前不支持扩展");
  }

  validateFrameHeader(header, maxPayload);

  if (!header.masked) {
    throw new Error("客户端帧未掩码：客户端帧必须带掩码");
  }

  const payloadOffset = header.headerLength;

  if (buffer.length < payloadOffset + header.payloadLength) {
    throw new Error("帧未完整：帧负载不完整");
  }

  const mask = buffer.subarray(payloadOffset - 4, payloadOffset);
  const payload = Buffer.from(
    buffer.subarray(payloadOffset, payloadOffset + header.payloadLength),
  );

  for (let i = 0; i < payload.length; i++) {
    payload[i] ^= mask[i % 4];
  }

  return {
    fin: header.fin,
    opcode: header.opcode,
    payload,
  };
}

export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  // 服务端到客户端 MASK=0，支持文本、二进制和控制帧。
  let header: Buffer;

  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  return Buffer.concat([header, payload]);
}
