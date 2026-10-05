import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ENTRY, runProcess, tempDir } from "./helpers.ts";

// These run the real `node src/index.ts` entry point (the shebang file) in a child process: exit codes, the
// "one JSON object on stdout" rule and stderr separation are properties of the process, not of `main`.
describe("entry point", () => {
  it("prints exactly one JSON object on stdout with --json and progress on stderr", () => {
    const repo = tempDir();
    const init = runProcess(repo, ["init", "--json"]);
    expect(init.code).toBe(0);
    expect(init.stdout.trim().split("\n")).toHaveLength(1);
    expect(init.json.ok).toBe(true);
    const render = runProcess(repo, ["render", "sfx/coin", "--json"]);
    expect(render.code).toBe(0);
    expect(render.stdout.trim().split("\n")).toHaveLength(1);
    expect(render.stderr).toContain("rendering sfx/coin");
    const quiet = runProcess(repo, [
      "render",
      "sfx/coin",
      "--force",
      "--json",
      "--quiet",
    ]);
    expect(quiet.stderr).toBe("");
  });

  it("maps errors to exit codes and JSON error objects", () => {
    const dir = tempDir();
    expect(runProcess(dir, ["nope"]).code).toBe(2);
    const noProject = runProcess(dir, ["validate", "--json"]);
    expect(noProject.code).toBe(3);
    expect(noProject.json).toMatchObject({
      error: { code: "no-project" },
      ok: false,
    });
    runProcess(dir, ["init"]);
    expect(runProcess(dir, ["describe", "sfx/missing", "--json"]).code).toBe(4);
  });
});

describe("studio command", () => {
  it("starts, streams JSON lines, answers the API, and stops cleanly on SIGINT", async () => {
    const repo = tempDir();
    expect(runProcess(repo, ["init"]).code).toBe(0);
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
    };
    expect(health.ok).toBe(true);
    expect(health.root).toBe(String(listening.root));
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
    const repo = tempDir();
    runProcess(repo, ["init"]);
    const net = await import("node:net");
    const blocker = net.createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", resolve)
    );
    const { port } = blocker.address() as { port: number };
    const r = runProcess(repo, [
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
