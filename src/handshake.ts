// hermes-ws/handshake.ts
// RFC 6455 握手流程
//
// [浏览器] --HTTP Upgrade /ws--> [Vite HTTP Server]
// [Vite HTTP Server] --101 Switching Protocols + Sec-WebSocket-Accept--> [浏览器]
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";

export const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function computeAccept(key: string): string {
  return createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
}

export function sendHandshake(socket: Duplex, key: string): void {
  // 只要写出 101 响应，浏览器端 WebSocket 就会进入 open 状态。
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${computeAccept(key)}\r\n\r\n`,
  );
}
