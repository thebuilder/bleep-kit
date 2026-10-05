// The websocket hub: the set of connected studio tabs and the broadcast of ServerMessages.
import type { WebSocket } from "ws";

export interface Hub {
  add: (socket: WebSocket) => void;
  broadcast: (message: Record<string, unknown>) => void;
  count: () => number;
}

export function createHub(
  onMessage?: (message: Record<string, unknown>) => void
): Hub {
  const sockets = new Set<WebSocket>();
  return {
    add: (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => sockets.delete(socket));
    },
    broadcast: (message) => {
      onMessage?.(message);
      const text = JSON.stringify(message);
      for (const s of sockets) {
        if (s.readyState === s.OPEN) {
          s.send(text);
        }
      }
    },
    count: () => [...sockets].filter((s) => s.readyState === s.OPEN).length,
  };
}
