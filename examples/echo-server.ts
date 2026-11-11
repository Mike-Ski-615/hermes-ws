import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type MinimalWebSocket, MinimalWebSocketServer } from "../src/index.ts";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const examplesDirectory = dirname(fileURLToPath(import.meta.url));
const indexFile = join(examplesDirectory, "index.html");

const wss = new MinimalWebSocketServer({ maxPayload: 64 * 1024 });

function event(type: "message" | "system", text: string): string {
  return JSON.stringify({
    type,
    text,
    clients: wss.clients.size,
    sentAt: new Date().toISOString(),
  });
}

wss.on("connection", (ws: MinimalWebSocket) => {
  ws.on("error", (error: Error) => {
    console.error("[demo] websocket error:", error.message);
  });

  ws.send(event("system", "Connected. Open this page in a second tab to test broadcast."));
  wss.broadcast(event("system", `A client joined (${wss.clients.size} online).`), ws);

  ws.on("message", (message: string | Buffer, isBinary: boolean) => {
    if (isBinary) {
      ws.send(message);
      return;
    }

    wss.broadcast(event("message", message));
  });

  ws.on("close", () => {
    wss.broadcast(event("system", `A client left (${wss.clients.size} online).`));
  });
});

const server = createServer(async (request, response) => {
  const requestHost = request.headers.host ?? `${host}:${port}`;
  const pathname = new URL(request.url ?? "/", `http://${requestHost}`).pathname;

  if (pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, clients: wss.clients.size }));
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    try {
      const html = await readFile(indexFile, "utf8");
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      });
      response.end(html);
    } catch (error) {
      console.error("[demo] failed to read index.html:", error);
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("Failed to load the demo page.");
    }
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

server.on("upgrade", (request, socket, head) => {
  const requestHost = request.headers.host ?? `${host}:${port}`;
  const pathname = new URL(request.url ?? "/", `http://${requestHost}`).pathname;

  if (pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

server.listen(port, host, () => {
  console.log(`[demo] hermes-ws running at http://${host}:${port}`);
  console.log("[demo] WebSocket endpoint: /ws");
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[demo] ${signal} received, closing connections...`);
  wss.close(() => {
    server.close(() => process.exit(0));
  });

  setTimeout(() => process.exit(0), 1_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
