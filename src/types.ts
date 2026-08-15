// hermes-ws/types.ts
import type { MinimalWebSocket } from "./connection.js";
import type { MinimalWebSocketServer } from "./server.js";

export interface HermesWsPluginOptions {
  path?: string;
  maxPayload?: number;
  onConnection?: (ws: MinimalWebSocket, wss: MinimalWebSocketServer) => void;
}

export interface MinimalWebSocketServerOptions {
  maxPayload?: number;
}
