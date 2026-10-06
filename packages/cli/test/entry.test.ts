import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENTRY, makeProject, run, runProcess, tempDir } from "./helpers.ts";

const pkg = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string };

// These run the real `node src/index.ts` entry point (the shebang file) in a child process: exit codes, the
// "one JSON object on stdout" rule and stderr separation are properties of the process, not of `main`. A process
// costs most of a second to start, so each property gets one, and the rest goes through `main` in this process.
describe("entry point", () => {
  it("prints exactly one JSON object on stdout with --json and progress on stderr", async () => {
    const { repo } = await makeProject();
    const render = runProcess(repo, ["render", "sfx/coin", "--json"]);
    expect(render.code).toBe(0);
    expect(render.stdout.trim().split("\n")).toHaveLength(1);
    expect(render.json.renders.map((r: { ref: string }) => r.ref)).toEqual([
      "sfx/coin",
    ]);
    expect(render.stderr).toContain("rendering sfx/coin");
    // --quiet is the writer `main` is handed, so it needs no process of its own
    const quiet = await run(repo, [
      "render",
      "sfx/coin",
      "--force",
      "--json",
      "--quiet",
    ]);
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).toBe("");
  });

  it("maps errors to exit codes and JSON error objects", async () => {
    const dir = tempDir();
    const unknown = runProcess(dir, ["nope", "--json"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stdout.trim().split("\n")).toHaveLength(1);
    expect(unknown.json).toMatchObject({ error: { code: "usage" }, ok: false });
    expect(unknown.stderr).toContain("error: unknown command");
    const noProject = await run(dir, ["validate", "--json"]);
    expect(noProject.code).toBe(3);
    expect(noProject.json).toMatchObject({
      error: { code: "no-project" },
      ok: false,
    });
    await run(dir, ["init"]);
    const missing = await run(dir, ["describe", "sfx/missing", "--json"]);
    expect(missing.code).toBe(4);
    expect(missing.json).toMatchObject({
      error: { code: "not-found" },
      ok: false,
    });
  });
});

describe("studio command", () => {
  it("starts, streams JSON lines, answers the API, and stops cleanly on SIGINT", async () => {
    const { repo } = await makeProject();
    const child = spawn(
      process.execPath,
      [ENTRY, "studio", "--port", "0", "--api-only", "--json"],
      {
        cwd: repo,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const lines: string[] = [];
    let buffer = "";
    const waiters: (() => void)[] = [];
    child.stdout.on("data", (d) => {
      buffer += String(d);
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      lines.push(...parts);
      for (const w of waiters.splice(0)) {
        w();
      }
    });
    const nextLine = async (
      match: (o: Record<string, unknown>) => boolean
    ): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        for (const l of lines) {
          const o = JSON.parse(l) as Record<string, unknown>;
          if (match(o)) {
            return o;
          }
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out; lines: ${lines.join("|")}`);
        }
        // biome-ignore lint/performance/noAwaitInLoops: a polling loop, each pass waits for the next line or 200 ms
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 200);
        });
      }
    };
    const listening = await nextLine((o) => o.type === "listening");
    expect(listening).toMatchObject({ apiOnly: true, type: "listening" });
    const url = String(listening.url);
    const health = (await (await fetch(`${url}/api/health`)).json()) as {
      ok: boolean;
      root: string;
      version: string;
    };
    expect(health).toEqual({
      ok: true,
      root: fs.realpathSync(path.join(repo, "audio")),
      version: pkg.version,
    });
    expect(listening.root).toBe(health.root);
    const exit = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code))
    );
    child.kill("SIGINT");
    expect(await exit).toBe(0);
    expect(lines.map((l) => JSON.parse(l)).at(-1)).toMatchObject({
      ok: true,
      type: "stopped",
    });
  });

  it("exits 6 when the port is taken, with a fix", async () => {
    const { repo } = await makeProject();
    const net = await import("node:net");
    const blocker = net.createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", resolve)
    );
    const { port } = blocker.address() as { port: number };
    const r = await run(repo, [
      "studio",
      "--port",
      String(port),
      "--api-only",
      "--json",
    ]);
    blocker.close();
    expect(r.code).toBe(6);
    expect(r.json).toMatchObject({ error: { code: "bind" }, ok: false });
    expect(r.json.error.hint).toContain("--port");
  });
});
