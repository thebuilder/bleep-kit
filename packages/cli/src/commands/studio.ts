import { spawn } from "node:child_process";
import { CliError, display } from "../output.ts";
import { openProject } from "../project.ts";
import { startServer } from "../server/index.ts";
import { findStudioDist, STUDIO_BUILD_HINT } from "../server/static.ts";
import type { CommandSpec } from "./types.ts";

function openCommand(url: string): [string, string[]] {
  if (process.platform === "darwin") {
    return ["open", [url]];
  }
  if (process.platform === "win32") {
    return ["cmd", ["/c", "start", "", url]];
  }
  return ["xdg-open", [url]];
}

function openBrowser(url: string): void {
  const [cmd, args] = openCommand(url);
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // no browser available: the URL is printed anyway
  }
}

export const studioCommand: CommandSpec = {
  description:
    "Starts the studio server on 127.0.0.1: the JSON API under /api, a websocket at /ws that pushes file changes made " +
    "on disk to every open tab, and (when apps/studio/dist is built) the studio itself at /. Runs until Ctrl-C. " +
    "Without a built studio the server still runs as an API: build it with `pnpm --filter @bleepkit/studio build`, or " +
    "use `pnpm dev` (Vite), which proxies /api and /ws to this server (start this with --api-only). " +
    "[dir] is the project folder; without it the project is found like every other command. " +
    'With --json it prints {"type":"listening","url":...} and then one JSON line per file event.',
  examples: [
    "bleepkit studio",
    "bleepkit studio game/audio --port 5174 --open",
    "bleepkit studio --api-only --port 5174",
  ],
  flags: [
    {
      default: "5174",
      description: "port to listen on (0 picks a free one)",
      name: "port",
      type: "number",
      valueName: "<n>",
    },
    {
      description:
        "open the studio in a browser (default: only when run from a terminal)",
      name: "open",
      type: "boolean",
    },
    {
      description: "serve only /api and /ws (for the Vite dev server)",
      name: "api-only",
      type: "boolean",
    },
  ],
  name: "studio",
  noProject: true,
  run: async (ctx, args) => {
    const [explicit] = args.positionals;
    const pc = openProject(ctx, { lenient: true }, explicit);
    const port = args.num("port") ?? 5174;
    if (!(Number.isInteger(port) && port >= 0 && port <= 65_535)) {
      throw new CliError("usage", `--port must be 0 to 65535 (got ${port})`);
    }
    const apiOnlyFlag = args.bool("api-only") ?? false;
    const dist = apiOnlyFlag ? null : findStudioDist();
    const apiOnly = apiOnlyFlag || dist === null;
    if (!apiOnlyFlag && dist === null) {
      ctx.err(`note: ${STUDIO_BUILD_HINT}`);
      ctx.err("Serving the API only.");
    }
    const server = await startServer({
      apiOnly: apiOnlyFlag,
      onMessage: (message) => {
        if (ctx.json) {
          ctx.emit(message);
        } else if (
          !ctx.quiet &&
          (message.type === "file" || message.type === "deleted")
        ) {
          ctx.err(
            `${message.type === "file" ? "changed" : "deleted"} ${String(message.path)}`
          );
        } else if (!ctx.quiet && message.type === "play") {
          ctx.err(`play ${String(message.ref)}`);
        }
      },
      port,
      root: pc.root,
      studioDist: dist,
      version: ctx.version,
    });
    const shown = `http://localhost:${server.port}`;
    if (ctx.json) {
      ctx.emit({
        apiOnly,
        project: pc.root,
        root: pc.root,
        type: "listening",
        url: shown,
      });
    } else {
      ctx.out(
        `Studio ${apiOnly ? "API" : "server"} for ${pc.project.name} (${display(ctx.cwd, pc.root)}) listening on ${shown}${apiOnly ? "  (API and websocket only)" : ""}\nPress Ctrl-C to stop.`
      );
    }
    const wantOpen = args.bool("open") ?? (ctx.isTTY && !ctx.json && !apiOnly);
    if (wantOpen && !apiOnly) {
      openBrowser(shown);
    }
    await new Promise<void>((resolve) => {
      const stop = () => {
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await server.close();
    return { human: "Studio stopped.", json: { ok: true, type: "stopped" } };
  },
  summary: "start the studio server (HTTP API, websocket, built studio)",
  usage: "studio [dir] [--port 5174] [--open] [--no-open] [--api-only]",
};
