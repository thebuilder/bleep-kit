// The studio is a plain Vite app: `pnpm dev` serves it with hot reload, `pnpm build` writes dist/.
// The workspace packages are TypeScript sources, which Vite compiles like the studio's own files.
import { defineConfig } from "vite";

// Cross-origin isolation, so SharedArrayBuffer (audio ring buffers shared with the AudioWorklet) is available.
// Everything the page loads must then be same-origin or opt in with CORP/CORS headers.
const isolation = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export default defineConfig({
  // relative asset paths, so dist/ works from any folder or subpath it is served from
  base: "./",
  build: {
    emptyOutDir: true,
    outDir: "dist",
    target: "es2022",
  },
  preview: { headers: isolation },
  server: { headers: isolation },
});
