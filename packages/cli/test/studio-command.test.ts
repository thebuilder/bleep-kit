// `bleepkit studio` in this process (entry.test.ts runs it as a child process, which does not count for coverage):
// it serves until a signal, reports what happens on disk and what the API is asked to play, and stops with exit 0.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { makeProject } from "./helpers.ts";

async function until(what: string, test: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!test()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: a polling loop, each pass waits 25 ms for the server
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function stop(): void {
  process.emit("SIGINT");
}

describe("studio command in process", () => {
  it("prints where it listens, narrates file changes and play requests, and stops on SIGINT", async () => {
    const { project, repo } = await makeProject();
    let out = "";
    let err = "";
    const done = main(["studio", "--port", "0", "--api-only"], {
      cwd: repo,
      isTTY: false,
      stderr: (t) => {
        err += t;
      },
      stdout: (t) => {
        out += t;
      },
    });
    try {
      await until("the listening line", () => /listening on http/.test(out));
      const url = /listening on (http:\/\/localhost:\d+)/.exec(out)?.[1];
      expect(url).toBeDefined();
      expect(out).toContain("(API and websocket only)");
      const file = path.join(project, "sfx", "fresh.json");
      fs.copyFileSync(path.join(project, "sfx", "coin.json"), file);
      await until("the file event", () => err.includes("changed sfx/fresh"));
      fs.rmSync(file);
      await until("the delete event", () => err.includes("deleted sfx/fresh"));
      const played = await fetch(`${url}/api/play`, {
        body: JSON.stringify({ ref: "sfx/coin" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(played.status).toBe(200);
      await until("the play event", () => err.includes("play sfx/coin"));
    } finally {
      stop();
    }
    expect(await done).toBe(0);
    expect(out).toContain("Studio stopped.");
  });

  it("with --json streams the listening line, one JSON line per event and the stop line", async () => {
    const { project, repo } = await makeProject();
    const lines: string[] = [];
    const done = main(["studio", "--port", "0", "--api-only", "--json"], {
      cwd: repo,
      isTTY: false,
      stderr: () => undefined,
      stdout: (t) => {
        lines.push(...t.split("\n").filter((l) => l !== ""));
      },
    });
    const events = () =>
      lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    try {
      await until("the listening line", () => lines.length > 0);
      const first = events()[0] as {
        apiOnly: boolean;
        root: string;
        type: string;
        url: string;
      };
      expect(first).toMatchObject({ apiOnly: true, type: "listening" });
      expect(first.root).toBe(fs.realpathSync(project));
      fs.copyFileSync(
        path.join(project, "sfx", "coin.json"),
        path.join(project, "sfx", "fresh.json")
      );
      await until("the file message", () =>
        events().some((e) => e.type === "file")
      );
      await fetch(`${first.url}/api/play`, {
        body: JSON.stringify({ ref: "sfx/coin" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      await until("the play message", () =>
        events().some((e) => e.type === "play")
      );
    } finally {
      stop();
    }
    expect(await done).toBe(0);
    const all = events();
    expect(all.find((e) => e.type === "file")).toMatchObject({
      path: "sfx/fresh.json",
    });
    expect(all.find((e) => e.type === "play")).toMatchObject({
      ref: "sfx/coin",
      visual: false,
    });
    // every line of stdout is one JSON object that says what it is, and the last one is the stop line
    expect(all.every((e) => typeof e.type === "string")).toBe(true);
    expect(all.at(-1)).toMatchObject({ ok: true, type: "stopped" });
  });
});
