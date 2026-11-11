# hermes-ws

一个基于 Node.js、面向 Vite 开发环境的最小 WebSocket Server 实现。

项目直接实现 RFC 6455 的基础帧、握手和连接生命周期，不依赖 `ws` 或 `socket.io`。目标不是覆盖完整 WebSocket 生态，而是提供一个体积小、依赖少、职责明确的基础实现。

[![ci](https://github.com/Mike-Ski-615/hermes-ws/actions/workflows/ci.yml/badge.svg)](https://github.com/Mike-Ski-615/hermes-ws/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/version-0.2.0-blue)](package.json)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## Demo

仓库内置一个可运行的广播 Demo，不依赖外部服务：

```bash
bun install
bun run demo
```

打开 <http://127.0.0.1:3000>，再开一个标签页访问同一地址。在任意一页发送消息，两页都会收到；页面同时显示连接状态、在线客户端数和系统事件。

Demo 覆盖的真实路径：

- 浏览器原生 `WebSocket` 发起 HTTP Upgrade
- `Sec-WebSocket-Key` 握手并返回 `101 Switching Protocols`
- Text Frame 编解码
- Broadcast 到所有已连接客户端
- Close Frame 与客户端集合清理

相关文件：[examples/echo-server.ts](examples/echo-server.ts)、[examples/index.html](examples/index.html)。

## 特性

- HTTP Upgrade / 101 握手
- `Sec-WebSocket-Key`
- WebSocket Version 13
- `Upgrade` / `Connection` 校验
- Text / Binary 消息
- Ping / Pong
- Close
- UTF-8 校验
- MASK 校验
- RSV 校验
- Control Frame 限制
- `maxPayload` 限制
- TCP 粘包 / 拆包
- `initialData`（握手 head 中携带的首帧）
- 客户端集合与 Broadcast
- Server 生命周期
- Vite Plugin

## 快速开始

需要 Node.js 20+；运行 Demo 需要 Bun。

```bash
bun install
bun test
bun run typecheck
bun run build
```

## Server 用法

```ts
import { createServer } from "node:http";
import { MinimalWebSocketServer } from "hermes-ws";

const wss = new MinimalWebSocketServer({
  maxPayload: 16 * 1024 * 1024,
});

wss.on("connection", (ws) => {
  ws.on("error", (error) => {
    console.error(error);
  });

  ws.on("message", (message, isBinary) => {
    if (isBinary) {
      ws.send(message);
    } else {
      ws.send(`echo: ${message}`);
    }
  });

  ws.on("close", (code, reason) => {
    console.log("client closed", code, reason.toString());
  });
});

const server = createServer();

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");

  if (pathname !== "/ws") return;

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

server.listen(3000);
```

## Vite Plugin 用法

```ts
import { defineConfig } from "vite";
import { hermesWs } from "hermes-ws";

export default defineConfig({
  plugins: [
    hermesWs({
      path: "/ws",
      maxPayload: 16 * 1024 * 1024,

      onConnection(ws, wss) {
        ws.on("message", (message) => {
          wss.broadcast(message);
        });
      },
    }),
  ],
});
```

`hermesWs` 只负责 Vite upgrade、路径匹配与 WebSocket Server 生命周期，业务逻辑通过 `onConnection` 注入。

## 客户端用法

客户端直接使用浏览器原生 WebSocket，不需要引入 `hermes-ws`：

```js
const ws = new WebSocket("ws://localhost:3000/ws");

ws.onopen = () => ws.send("hello");

ws.onmessage = (event) => {
  console.log(event.data);
};

ws.onclose = (event) => {
  console.log(event.code, event.reason);
};
```

## Connection API

```ts
ws.send("hello");
ws.send(Buffer.from([1, 2, 3]));

ws.ping();
ws.pong();

ws.close(1000, "bye");
ws.destroy();

ws.readyState;
```

事件：

```ts
ws.on("message", (message, isBinary) => {});
ws.on("close", (code, reason) => {});
ws.on("error", (error) => {});
ws.on("pong", (data) => {});
```

> 使用 `MinimalWebSocket` 时建议始终监听 `error` 事件；Node.js 的 `EventEmitter` 对未处理的 `error` 事件会抛出异常。

## Server API

```ts
const wss = new MinimalWebSocketServer({
  maxPayload: 16 * 1024 * 1024,
});

wss.on("connection", (ws) => {});

wss.broadcast("hello everyone");
wss.broadcast("hello others", ws);

wss.close(callback);
```

## 工程证据

| 可验证内容 | 位置 / 命令 |
| --- | --- |
| GitHub Actions 自动执行测试、类型检查与构建 | [.github/workflows/ci.yml](.github/workflows/ci.yml) |
| 六组测试：帧、连接、客户端、服务端、Vite 插件、真实 TCP 集成 | [test/](test) |
| 用裸 TCP 客户端完成握手、Ping/Pong、Text、Binary、Close | [test/integration.test.ts](test/integration.test.ts) |
| 7 / 16 / 64 位长度、MASK / RSV / FIN、UTF-8 与分片拒绝 | [test/frame.test.ts](test/frame.test.ts)、[test/connection.test.ts](test/connection.test.ts) |
| 协议编解码与连接生命周期分层 | [src/frame.ts](src/frame.ts)、[src/connection.ts](src/connection.ts) |
| Server 客户端集合与 Broadcast | [src/server.ts](src/server.ts) |
| 无需测试框架即可手动验证的浏览器 Demo | [examples/echo-server.ts](examples/echo-server.ts) |

CI 实际执行：

```bash
bun test
bun run typecheck
bun run build
```

## 协议边界

支持：

```text
TEXT + FIN
BINARY + FIN
PING + FIN
PONG + FIN
CLOSE + FIN
```

拒绝：

```text
TEXT + !FIN
BINARY + !FIN
CONTINUATION
```

明确不做：

- 消息分片
- WebSocket Extensions
- `permessage-deflate`
- 认证、重连、RPC、room、subscription
- 业务协议

业务协议应建立在 `hermes-ws` 之上，而不是进入核心。

## 版本

当前版本：`0.2.0`。
