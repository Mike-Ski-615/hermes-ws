import { describe, expect, test } from "bun:test";

import {
  decodeFrame,
  encodeFrame,
  getFrameLength,
  OPCODE,
} from "../src/frame.ts";

const MASK = Buffer.from([1, 2, 3, 4]);

function maskedFrame(
  opcode: number,
  payload: Buffer,
  { fin = true, rsv = 0 }: { fin?: boolean; rsv?: number } = {},
): Buffer {
  const masked = Buffer.from(payload);

  for (let i = 0; i < masked.length; i++) {
    masked[i] ^= MASK[i % 4];
  }

  let header: Buffer;

  if (payload.length < 126) {
    header = Buffer.alloc(6);
    header[0] = (fin ? 0x80 : 0) | rsv | opcode;
    header[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(8);
    header[0] = (fin ? 0x80 : 0) | rsv | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(14);
    header[0] = (fin ? 0x80 : 0) | rsv | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  header.set(MASK, header.length - 4);

  return Buffer.concat([header, masked]);
}

function maskedHeaderOnly(opcode: number, payloadLength: number): Buffer {
  let header: Buffer;

  if (payloadLength < 126) {
    header = Buffer.alloc(6);
    header[1] = 0x80 | payloadLength;
  } else if (payloadLength <= 0xffff) {
    header = Buffer.alloc(8);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payloadLength, 2);
  } else {
    header = Buffer.alloc(14);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payloadLength), 2);
  }

  header[0] = 0x80 | opcode;
  header.set(MASK, header.length - 4);

  return header;
}

describe("frame round trip", () => {
  test("decodes text and binary frames", () => {
    const text = decodeFrame(maskedFrame(OPCODE.TEXT, Buffer.from("hello")));
    const binary = decodeFrame(
      maskedFrame(OPCODE.BINARY, Buffer.from([1, 2, 3])),
    );

    expect(text.payload.toString()).toBe("hello");
    expect(binary.payload.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  test("handles 1 / 125 / 126 / 65535 / 65536 byte payloads", () => {
    for (const length of [1, 125, 126, 65535, 65536]) {
      const payload = Buffer.alloc(length, 0x41);
      const frame = decodeFrame(maskedFrame(OPCODE.BINARY, payload));

      expect(frame.payload.length).toBe(length);
      expect(frame.payload.equals(payload)).toBe(true);
    }
  });

  test("encodes 7 / 16 / 64 bit lengths", () => {
    expect(encodeFrame(OPCODE.TEXT, Buffer.alloc(1))[1]).toBe(1);
    expect(encodeFrame(OPCODE.TEXT, Buffer.alloc(125))[1]).toBe(125);

    const medium = encodeFrame(OPCODE.BINARY, Buffer.alloc(126));
    expect(medium[1]).toBe(126);
    expect(medium.readUInt16BE(2)).toBe(126);

    const large = encodeFrame(OPCODE.BINARY, Buffer.alloc(65536));
    expect(large[1]).toBe(127);
    expect(Number(large.readBigUInt64BE(2))).toBe(65536);
  });

  test("mask cycles for payload lengths 1 / 4 / 5 / 100", () => {
    for (const length of [1, 4, 5, 100]) {
      const payload = Buffer.alloc(length, 0x5a);
      const frame = decodeFrame(maskedFrame(OPCODE.BINARY, payload));

      expect(frame.payload.equals(payload)).toBe(true);
    }
  });
});

describe("frame validation", () => {
  test("rejects unmasked client frames", () => {
    expect(() => decodeFrame(Buffer.from([0x81, 0x01, 0x61]))).toThrow(
      "客户端帧未掩码",
    );
  });

  test("rejects RSV bits", () => {
    expect(() =>
      decodeFrame(maskedFrame(OPCODE.TEXT, Buffer.from("x"), { rsv: 0x40 })),
    ).toThrow("不支持的扩展");
  });

  test("rejects unknown opcodes", () => {
    expect(() => decodeFrame(maskedFrame(0x3, Buffer.alloc(0)))).toThrow(
      "暂不支持的操作码",
    );
  });

  test("reports unknown opcode before FIN validation", () => {
    expect(() =>
      decodeFrame(maskedFrame(0x3, Buffer.alloc(0), { fin: false })),
    ).toThrow("暂不支持的操作码");
  });

  test("rejects TEXT FIN=0", () => {
    expect(() =>
      decodeFrame(maskedFrame(OPCODE.TEXT, Buffer.from("x"), { fin: false })),
    ).toThrow("当前不支持消息分片");
  });

  test("rejects BINARY FIN=0", () => {
    expect(() =>
      decodeFrame(maskedFrame(OPCODE.BINARY, Buffer.from("x"), { fin: false })),
    ).toThrow("当前不支持消息分片");
  });

  test("rejects control frame FIN=0", () => {
    expect(() =>
      decodeFrame(maskedFrame(OPCODE.PING, Buffer.from("x"), { fin: false })),
    ).toThrow("控制帧必须");
  });

  test("rejects control frame payload over 125", () => {
    expect(() => decodeFrame(maskedHeaderOnly(OPCODE.PING, 126))).toThrow(
      "控制帧必须",
    );
  });

  test("rejects payload over maxPayload", () => {
    const buffer = maskedHeaderOnly(OPCODE.TEXT, 11);

    expect(() => getFrameLength(buffer, 10)).toThrow("消息过大");
    expect(() => decodeFrame(buffer, 10)).toThrow("消息过大");
  });
});
