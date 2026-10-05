// Serving apps/studio/dist at `/` with the cross-origin isolation headers SharedArrayBuffer needs.
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentType } from "./paths.ts";

export const ISOLATION_HEADERS = {
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
} as const;

export const STUDIO_BUILD_HINT =
  "The studio is not built. Run `pnpm --filter @bleepkit/studio build` and restart, or run `pnpm dev` (Vite) which proxies /api and /ws to this server; start this server with `bleepkit studio --api-only` for that.";

/** Where the built studio lives: next to the published CLI, or apps/studio/dist in the monorepo. */
export function findStudioDist(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.BLEEPKIT_STUDIO_DIST,
    path.resolve(here, "../studio"),
    path.resolve(here, "../../studio"),
    path.resolve(here, "../../../../apps/studio/dist"),
    path.resolve(here, "../../../apps/studio/dist"),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, "index.html"))) {
      return c;
    }
  }
  return null;
}

export function serveStatic(
  dist: string | null,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): void {
  if (!dist) {
    const text = `${STUDIO_BUILD_HINT}\n`;
    res.writeHead(404, {
      "content-length": Buffer.byteLength(text),
      "content-type": "text/plain; charset=utf-8",
    });
    res.end(text);
    return;
  }
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    rel = "/";
  }
  const target = path.normalize(
    path.join(dist, rel === "/" ? "index.html" : rel)
  );
  if (!(target === dist || target.startsWith(dist + path.sep))) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  let file = target;
  try {
    if (fs.statSync(file).isDirectory()) {
      file = path.join(file, "index.html");
    }
    const stat = fs.statSync(file);
    res.writeHead(200, {
      "cache-control": "no-cache",
      "content-length": stat.size,
      "content-type": contentType(file),
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`not found: ${pathname}\n`);
  }
}
