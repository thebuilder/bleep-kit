/* The ProjectStore that talks to the CLI's studio server (section 6.3): HTTP under /api, WebSocket at /ws. */
import type {
  FileEntry,
  FileJson,
  ProjectInfo,
  ProjectStore,
  ServerMessage,
  WriteResult,
} from "./store.ts";

const HTTP_SCHEME = /^http/;

interface Health {
  ok: boolean;
  root?: string;
  version?: string;
}

/** Is a studio server answering on this origin? */
export async function probeServer(
  base = "",
  timeoutMs = 1200
): Promise<Health | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`${base}/api/health`, {
      headers: { accept: "application/json" },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return null;
    }
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("json")) {
      return null;
    }
    const body = (await res.json()) as Health | null;
    return body?.ok ? body : null;
  } catch {
    return null;
  }
}

export class ServerStore implements ProjectStore {
  readonly mode = "server" as const;
  label: string;
  private readonly base: string;
  private readonly listeners = new Set<(m: ServerMessage) => void>();
  private socket: WebSocket | null = null;
  private retry = 500;
  private closed = false as boolean;

  constructor(base = "", root = "project folder") {
    this.base = base;
    this.label = root;
  }

  private url(path: string): string {
    return `${this.base}/api/file?path=${encodeURIComponent(path)}`;
  }

  private connect(): void {
    if (this.closed || typeof WebSocket === "undefined") {
      return;
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const origin = this.base
      ? this.base.replace(HTTP_SCHEME, "ws")
      : `${proto}//${location.host}`;
    try {
      const ws = new WebSocket(`${origin}/ws`);
      this.socket = ws;
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as ServerMessage;
          for (const fn of this.listeners) {
            fn(msg);
          }
        } catch {
          // a message that is not JSON is ignored
        }
      };
      ws.onopen = () => {
        this.retry = 500;
      };
      ws.onclose = () => {
        this.socket = null;
        if (!this.closed) {
          setTimeout(() => this.connect(), this.retry);
          this.retry = Math.min(8000, this.retry * 2);
        }
      };
    } catch {
      // no socket: the studio still works, it just does not see outside edits
    }
  }

  async open(): Promise<ProjectInfo> {
    const res = await fetch(`${this.base}/api/project`);
    if (!res.ok) {
      throw new Error(`The studio server answered ${res.status}`);
    }
    const info = (await res.json()) as ProjectInfo;
    this.label = info.root;
    this.connect();
    return info;
  }

  async list(): Promise<FileEntry[]> {
    const res = await fetch(`${this.base}/api/project`);
    return ((await res.json()) as ProjectInfo).files;
  }

  async readJson(path: string): Promise<FileJson> {
    const res = await fetch(this.url(path));
    if (!res.ok) {
      throw new Error(`Could not read ${path} (${res.status})`);
    }
    return (await res.json()) as FileJson;
  }

  async writeJson(
    path: string,
    json: unknown,
    ifMatch?: string
  ): Promise<WriteResult> {
    try {
      const res = await fetch(this.url(path), {
        body: JSON.stringify(ifMatch ? { ifMatch, json } : { json }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const body = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (res.ok) {
        return {
          etag: String(body.etag ?? ""),
          mtime: Number(body.mtime ?? Date.now()),
          ok: true,
        };
      }
      if (res.status === 412) {
        return {
          etag: String(body.etag ?? ""),
          json: body.json,
          ok: false,
          reason: "conflict",
        };
      }
      if (res.status === 422) {
        return {
          issues: (body.issues as never) ?? [],
          ok: false,
          reason: "invalid",
        };
      }
      return {
        message: String(body.error ?? res.status),
        ok: false,
        reason: "error",
      };
    } catch (err) {
      return { message: (err as Error).message, ok: false, reason: "error" };
    }
  }

  async remove(path: string): Promise<void> {
    await fetch(this.url(path), { method: "DELETE" });
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    const res = await fetch(this.url(path));
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  }

  async writeBytes(): Promise<void> {
    // renders are written by the server itself
  }

  subscribe(fn: (m: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.listeners.clear();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}/api/${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return res.json();
  }

  render(ref: string, options: Record<string, unknown> = {}): Promise<unknown> {
    return this.post("render", { options, ref });
  }

  analyzeRemote(ref: string): Promise<unknown> {
    return this.post("analyze", { ref });
  }

  exportAll(dryRun: boolean): Promise<unknown> {
    return this.post("export", { dryRun });
  }
}
