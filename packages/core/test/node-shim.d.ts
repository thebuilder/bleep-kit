/* The core tsconfig has no DOM and no Node types (the engine runs anywhere), but a few tests read fixtures, golden
   files and sources from disk and the bench logs to the console. These are the only Node names the tests use. */

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(
    path: string,
    options?: { recursive?: boolean }
  ): void;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { isDirectory: () => boolean };
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare class URL {
  constructor(url: string, base?: string | URL);
  readonly href: string;
}

interface ImportMeta {
  readonly url: string;
}

declare const process: { readonly env: Record<string, string | undefined> };

declare const console: { log: (...args: unknown[]) => void };
