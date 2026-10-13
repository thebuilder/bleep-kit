// The studio is a plain Vite app: `pnpm dev` serves it with hot reload, `pnpm build` writes dist/.
// The workspace packages are TypeScript sources, which Vite compiles like the studio's own files.
// In dev, /api and /ws go to the CLI's studio server (`bleepkit studio`), so the page edits the real project folder.
// /api/freesound/* is answered here instead, by the same handler the Vercel Function uses (server/freesound), with the
// key from .env.local; FREESOUND_FIXTURES=1 answers from made-up fixtures so no key or network is needed.
import path from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import type { HandlerDeps } from "./server/freesound/handler.ts";
import { isFreesoundPath, serveFreesound } from "./server/freesound/node.ts";

// Cross-origin isolation, so SharedArrayBuffer (audio ring buffers shared with the AudioWorklet) is available.
// Everything the page loads must then be same-origin or opt in with CORP/CORS headers.
const isolation = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

const STUDIO_SERVER = "http://127.0.0.1:5174";

const FIXTURE_FLAGS = new Set(["1", "true"]);

/** Serves /api/freesound/* from the dev server, before the proxy to the CLI server sees it. */
function freesoundDev(env: Record<string, string | undefined>): Plugin {
  let deps: Promise<HandlerDeps> | null = null;
  const loadDeps = (): Promise<HandlerDeps> => {
    if (!FIXTURE_FLAGS.has(env.FREESOUND_FIXTURES ?? "")) {
      return Promise.resolve({ env });
    }
    return import("./server/freesound/fixtures.ts").then((f) => ({
      env: { FREESOUND_CLIENT_SECRET: f.FIXTURE_KEY },
      fetch: f.createFixtureFetch().fetch,
    }));
  };
  return {
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!isFreesoundPath(req.url)) {
          next();
          return;
        }
        deps ??= loadDeps();
        deps
          .then((d) => serveFreesound(req, res, d))
          .catch((error: unknown) => {
            res.statusCode = 500;
            res.end(String(error));
          });
      });
    },
    name: "bleepkit-freesound",
  };
}

export default defineConfig(({ mode }) => {
  // .env.local in apps/studio (or the repository root) holds FREESOUND_CLIENT_SECRET; nothing here reaches the browser
  // because none of the names start with VITE_
  const root = import.meta.dirname;
  const env = {
    ...loadEnv(mode, path.resolve(root, "../.."), ""),
    ...loadEnv(mode, root, ""),
  };
  return {
    // relative asset paths, so dist/ works from any folder or subpath it is served from
    base: "./",
    build: {
      emptyOutDir: true,
      outDir: "dist",
      target: "es2022",
    },
    plugins: [freesoundDev(env)],
    preview: { headers: isolation },
    server: {
      headers: isolation,
      proxy: {
        "/api": { changeOrigin: true, target: STUDIO_SERVER },
        "/ws": { changeOrigin: true, target: STUDIO_SERVER, ws: true },
      },
    },
    worker: { format: "es" },
  };
});
