// hermes-ws/plugin.ts
import type { Plugin, ViteDevServer } from "vite";

import { MinimalWebSocketServer } from "./server.js";

import type { HermesWsPluginOptions } from "./types.js";

export function hermesWs(options: HermesWsPluginOptions = {}): Plugin {
  const path = options.path ?? "/ws";
  return {
    name: "hermes-ws",

    configureServer(server: ViteDevServer) {
      const wss = new MinimalWebSocketServer({
        maxPayload: options.maxPayload,
      });

      wss.on("connection", (ws) => {
        ws.on("error", (error: Error) => {
          if ((error as NodeJS.ErrnoException).code === "ECONNRESET") return;

          console.error("[hermes-ws] WebSocket error:", error);
        });

        options.onConnection?.(ws, wss);
      });

      console.log(
        "[vite-plugin-hermes-ws] WebSocket 已挂载到 Vite 开发服务器。",
      );

      server.httpServer!.on("upgrade", (req, socket, head) => {
        const { pathname } = new URL(req.url, "http://localhost");

        if (pathname !== path) return;

        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      });

      server.httpServer!.on("close", () => {
        wss.close();
      });
    },
  };
}

export default hermesWs;
