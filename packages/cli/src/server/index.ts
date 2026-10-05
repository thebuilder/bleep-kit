// The studio server (architecture.md 6.3): HTTP on 127.0.0.1, the JSON API, the websocket and the file watcher.
import http from "node:http";
import { WebSocketServer } from "ws";
import { CliError } from "../output.ts";
import { loadProjectFile } from "../project.ts";
import { type ApiState, HttpError, handleApi, sendJson } from "./api.ts";
import { createHub, type Hub } from "./hub.ts";
import { ISOLATION_HEADERS, serveStatic } from "./static.ts";
import { startWatcher } from "./watch.ts";

export interface ServerOptions {
  /** Serve only the API and websocket (the Vite dev server proxies to it). */
  apiOnly?: boolean;
  host?: string;
  /** Called with every broadcast message (the CLI prints them in --json mode). */
  onMessage?: (message: Record<string, unknown>) => void;
  port: number;
  root: string;
  /** Absolute path of the built studio, or null when there is none. */
  studioDist: string | null;
  version: string;
}

export interface RunningServer {
  close: () => Promise<void>;
  hub: Hub;
  port: number;
  state: ApiState;
  url: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostName(value: string): string {
  if (value.startsWith("[")) {
    return value.slice(0, value.indexOf("]") + 1);
  }
  return value.split(":")[0] ?? "";
}

/** Rejects DNS rebinding (Host) and cross-site pages (Origin): only localhost pages may drive this server. */
export function originAllowed(headers: http.IncomingHttpHeaders): boolean {
  const { host } = headers;
  if (host && !LOCAL_HOSTS.has(hostName(host))) {
    return false;
  }
  const { origin } = headers;
  if (origin) {
    try {
      const name = new URL(origin).hostname;
      return (
        LOCAL_HOSTS.has(name) || LOCAL_HOSTS.has(name.replace(/^\[|\]$/g, ""))
      );
    } catch {
      return false;
    }
  }
  return true;
}

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const hub = createHub(options.onMessage);
  const state: ApiState = {
    hub,
    known: new Map(),
    root: options.root,
    version: options.version,
  };
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    for (const [k, v] of Object.entries(ISOLATION_HEADERS)) {
      res.setHeader(k, v);
    }
    if (!originAllowed(req.headers)) {
      sendJson(res, 403, {
        error: "forbidden-origin",
        message: "this server only answers requests from localhost pages",
      });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      handleApi(state, req, res, url).catch((error: unknown) => {
        const f =
          error instanceof HttpError
            ? error
            : new HttpError(500, "internal", (error as Error).message);
        if (!res.headersSent) {
          sendJson(res, f.status, f.body);
        }
      });
      return;
    }
    if (options.apiOnly) {
      sendJson(res, 404, {
        error: "api-only",
        message:
          "this server runs with --api-only: open the Vite dev server (pnpm dev), which proxies /api and /ws here",
      });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, {
        error: "method-not-allowed",
        message: "static files take GET",
      });
      return;
    }
    serveStatic(options.studioDist, req, res, url.pathname);
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws" || !originAllowed(req.headers)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      hub.add(ws);
      let project: unknown = null;
      try {
        ({ project } = loadProjectFile(options.root));
      } catch {
        project = null;
      }
      ws.send(JSON.stringify({ project, root: options.root, type: "hello" }));
    });
  });

  const watcher = startWatcher(state, (message) =>
    hub.broadcast({ level: "warn", message, type: "log" })
  );

  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      watcher.close();
      reject(
        new CliError(
          "bind",
          error.code === "EADDRINUSE"
            ? `port ${options.port} is already in use`
            : `could not start the server on port ${options.port}: ${error.message}`,
          {
            hint: "Pick another port with --port <n> (--port 0 chooses a free one), or stop the other process.",
          }
        )
      );
    });
    server.listen(options.port, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : options.port;
      resolve({
        close: () =>
          new Promise<void>((done) => {
            watcher.close();
            for (const client of wss.clients) {
              client.terminate();
            }
            wss.close();
            server.close(() => done());
            server.closeAllConnections();
          }),
        hub,
        port,
        state,
        url: `http://${options.host ?? "127.0.0.1"}:${port}`,
      });
    });
  });
}
