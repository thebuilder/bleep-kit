import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STUBBED } from "../src/stubs.ts";
import { makeProject, readJson, run, tempDir, writeJson } from "./helpers.ts";

const encodersReady = !(
  STUBBED.includes("tools.encodeOgg") || STUBBED.includes("tools.encodeMp3")
);

describe("global behavior", () => {
  it("prints the overview and exits 0 with no arguments", async () => {
    const r = await run(tempDir(), []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Commands:");
    expect(r.stdout).toContain("help formats");
  });

  it("exits 2 for an unknown command with a did-you-mean hint, as JSON on request", async () => {
    const r = await run(tempDir(), ["rendr", "--json"]);
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ error: { code: "usage" }, ok: false });
    expect(r.json.error.hint).toContain("render");
    expect(r.stderr).toContain("error: unknown command");
  });

  it("exits 2 for an unknown flag and names the closest one", async () => {
    const { repo } = await makeProject();
    const r = await run(repo, ["render", "--analize"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--analyze");
  });

  it("exits 3 with code no-project outside a project", async () => {
    const r = await run(tempDir(), ["list", "--json"]);
    expect(r.code).toBe(3);
    expect(r.json).toEqual({
      error: {
        code: "no-project",
        hint: expect.stringContaining("bleepkit init"),
        message: expect.any(String),
      },
      ok: false,
    });
  });

  it("every command has help with an example", async () => {
    const names = [
      "init",
      "new",
      "mutate",
      "validate",
      "list",
      "render",
      "analyze",
      "describe",
      "play",
      "export",
      "studio",
      "help",
    ];
    for (const name of names) {
      const r = await run(tempDir(), [name, "--help"]);
      expect(r.code, name).toBe(0);
      expect(r.stdout, name).toContain("Examples:");
      expect(r.stdout, name).toContain(`bleepkit ${name}`);
    }
  });

  it("finds the project from a subfolder and from --project", async () => {
    const { project, repo } = await makeProject();
    const sub = path.join(repo, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });
    expect((await run(sub, ["list", "--json"])).code).toBe(0);
    expect(
      (await run(tempDir(), ["list", "--project", project, "--json"])).json.root
    ).toBe(project);
    const bad = await run(tempDir(), ["list", "--project", repo, "--json"]);
    expect(bad.code).toBe(3);
    expect(bad.json.error.hint).toContain(project);
  });
});

describe("init, new, list, validate", () => {
  it("init writes the starter project and refuses to overwrite without --force", async () => {
    const repo = tempDir();
    const r = await run(repo, [
      "init",
      "--chip",
      "gameboy",
      "--name",
      "Test Game",
      "--json",
    ]);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.files).toEqual(
      expect.arrayContaining([
        "project.json",
        ".gitignore",
        "instruments/lead.json",
        "instruments/bass.json",
        "instruments/drums.json",
        "sfx/coin.json",
      ])
    );
    const project = readJson(path.join(repo, "audio", "project.json")) as {
      chip: string;
      name: string;
    };
    expect(project).toMatchObject({ chip: "gameboy", name: "Test Game" });
    for (const d of ["sfx", "instruments", "songs", "out"]) {
      expect(fs.statSync(path.join(repo, "audio", d)).isDirectory()).toBe(true);
    }
    expect(
      fs.readFileSync(path.join(repo, "audio", ".gitignore"), "utf8")
    ).toBe("out/\n");
    const again = await run(repo, ["init"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("--force");
    expect((await run(repo, ["init", "--force", "--json"])).code).toBe(0);
  });

  it("init rejects a chip it does not know with exit 2", async () => {
    const r = await run(tempDir(), ["init", "--chip", "amiga"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("nes");
  });

  it("new sfx writes a document, exits 1 when it exists and 2 without --category", async () => {
    const { project, repo } = await makeProject();
    const r = await run(repo, [
      "new",
      "sfx",
      "jump",
      "--category",
      "jump",
      "--json",
    ]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, path: "sfx/jump.json" });
    expect(typeof r.json.description).toBe("string");
    expect(r.json.doc).toMatchObject({
      category: "jump",
      chip: "nes",
      version: 1,
    });
    expect(
      (readJson(path.join(project, "sfx", "jump.json")) as { id?: string }).id
    ).toBeUndefined();
    expect(
      (await run(repo, ["new", "sfx", "jump", "--category", "jump"])).code
    ).toBe(1);
    expect(
      (await run(repo, ["new", "sfx", "jump", "--category", "jump", "--force"]))
        .code
    ).toBe(0);
    expect((await run(repo, ["new", "sfx", "x", "--json"])).code).toBe(2);
    expect(
      (await run(repo, ["new", "sfx", "Bad Id", "--category", "coin"])).code
    ).toBe(2);
  });

  it("new sfx is deterministic for a given seed", async () => {
    const { repo } = await makeProject();
    const a = await run(repo, [
      "new",
      "sfx",
      "a",
      "--category",
      "laser",
      "--seed",
      "5",
      "--json",
    ]);
    const b = await run(repo, [
      "new",
      "sfx",
      "b",
      "--category",
      "laser",
      "--seed",
      "5",
      "--json",
    ]);
    expect({ ...a.json.doc, name: "" }).toEqual({ ...b.json.doc, name: "" });
  });

  it("new instrument and new song write validated documents", async () => {
    const { repo } = await makeProject();
    const inst = await run(repo, [
      "new",
      "instrument",
      "pluck",
      "--kind",
      "pulse",
      "--preset",
      "bell",
      "--json",
    ]);
    expect(inst.code).toBe(0);
    expect(inst.json.doc).toMatchObject({ kind: "pulse", name: "pluck" });
    const song = await run(repo, [
      "new",
      "song",
      "title",
      "--tempo",
      "140",
      "--mml",
      "pulse1=o4 l8 cdefgab>c",
      "--json",
    ]);
    expect(song.code).toBe(0);
    expect(song.json.doc.tempo).toBe(140);
    expect(song.json.doc.channels[0]).toMatchObject({
      id: "pulse1",
      instrument: "lead",
      mml: "o4 l8 cdefgab>c",
    });
    const wrongChannel = await run(repo, [
      "new",
      "song",
      "x",
      "--mml",
      "nope=c d",
    ]);
    expect(wrongChannel.code).toBe(2);
    expect(wrongChannel.stderr).toContain("pulse1");
    const badMml = await run(repo, [
      "new",
      "song",
      "y",
      "--mml",
      "pulse1=o4 cdxfg",
    ]);
    expect(badMml.code).toBe(1);
    expect(badMml.stderr).toContain("help formats mml");
    const loop = await run(repo, [
      "new",
      "song",
      "z",
      "--template",
      "loop8",
      "--json",
    ]);
    expect(loop.json.doc).toMatchObject({ loop: 0, order: expect.any(Array) });
    expect(loop.json.doc.order).toHaveLength(8);
  });

  it("list shows documents of every kind and a single kind", async () => {
    const { repo } = await makeProject();
    const all = await run(repo, ["list", "--json"]);
    expect(all.json.ok).toBe(true);
    expect(all.json.sfx.map((s: { id: string }) => s.id)).toEqual(["coin"]);
    expect(all.json.instruments.map((s: { id: string }) => s.id)).toEqual([
      "bass",
      "drums",
      "lead",
    ]);
    expect(all.json.songs).toEqual([]);
    expect(all.json.sfx[0]).toMatchObject({
      category: "coin",
      chip: "nes",
      render: null,
    });
    const one = await run(repo, ["list", "instruments", "--json"]);
    expect(Object.keys(one.json).sort()).toEqual(["instruments", "ok", "root"]);
    expect((await run(repo, ["list", "banana"])).code).toBe(2);
  });

  it("validate passes on a fresh project and fails (exit 1) with paths on a broken one", async () => {
    const { project, repo } = await makeProject();
    const ok = await run(repo, ["validate", "--json"]);
    expect(ok.code).toBe(0);
    expect(ok.json.ok).toBe(true);
    expect(ok.json.documents.map((d: { ref: string }) => d.ref)).toEqual(
      expect.arrayContaining(["project", "sfx/coin", "instrument/lead"])
    );
    const coin = readJson(path.join(project, "sfx", "coin.json")) as Record<
      string,
      unknown
    >;
    writeJson(path.join(project, "sfx", "coin.json"), {
      ...coin,
      volume: "loud",
      wave: 42,
    });
    const bad = await run(repo, ["validate", "sfx/coin", "--json"]);
    expect(bad.code).toBe(1);
    expect(bad.json.ok).toBe(false);
    const doc = bad.json.documents[0];
    expect(doc.ok).toBe(false);
    expect(
      doc.issues.some(
        (i: { path: string; severity: string }) =>
          i.path === "/volume" && i.severity === "error"
      )
    ).toBe(true);
    fs.writeFileSync(path.join(project, "sfx", "broken.json"), "{ nope");
    const parse = await run(repo, ["validate", "sfx/broken", "--json"]);
    expect(parse.code).toBe(1);
    expect(parse.json.documents[0].issues[0].message).toContain(
      "not valid JSON"
    );
    expect((await run(repo, ["validate", "sfx/missing"])).code).toBe(4);
  });

  it("validate checks a song against the project's instruments", async () => {
    const { repo } = await makeProject();
    await run(repo, ["new", "song", "s", "--mml", "pulse1=@lead c d e"]);
    fs.rmSync(path.join(repo, "audio", "instruments", "lead.json"));
    const r = await run(repo, ["validate", "song/s", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.stringify(r.json)).toContain("lead");
  });
});

describe("mutate and describe", () => {
  it("mutate writes numbered variants without overwriting and honors --out", async () => {
    const { project, repo } = await makeProject();
    const a = await run(repo, ["mutate", "sfx/coin", "--count", "2", "--json"]);
    expect(a.code).toBe(0);
    expect(a.json.results.map((r: { id: string }) => r.id)).toEqual([
      "coin-m1",
      "coin-m2",
    ]);
    expect(a.json.results[0]).toMatchObject({ path: "sfx/coin-m1.json" });
    expect(typeof a.json.results[0].description).toBe("string");
    const b = await run(repo, ["mutate", "sfx/coin", "--json"]);
    expect(b.json.results[0].id).toBe("coin-m3");
    const c = await run(repo, [
      "mutate",
      "sfx/coin",
      "--out",
      "coin-wild",
      "--amount",
      "0.5",
      "--json",
    ]);
    expect(c.json.results[0].id).toBe("coin-wild");
    expect(fs.existsSync(path.join(project, "sfx", "coin-wild.json"))).toBe(
      true
    );
    expect(
      (await run(repo, ["mutate", "sfx/coin", "--out", "coin-wild"])).code
    ).toBe(1);
    expect((await run(repo, ["mutate", "song/x"])).code).toBe(2);
    expect(
      (await run(repo, ["mutate", "sfx/coin", "--amount", "3"])).code
    ).toBe(2);
  });

  it("describe explains sfx, songs and instruments", async () => {
    const { repo } = await makeProject();
    await run(repo, [
      "new",
      "song",
      "title",
      "--mml",
      "pulse1=o4 l8 cdefgab>c",
    ]);
    const sfx = await run(repo, ["describe", "sfx/coin", "--json"]);
    expect(sfx.json).toMatchObject({
      kind: "sfx",
      ok: true,
      ref: "sfx/coin",
      render: null,
    });
    expect(sfx.json.description.length).toBeGreaterThan(20);
    expect(sfx.json.facts).toMatchObject({ category: "coin", chip: "nes" });
    const song = await run(repo, ["describe", "title", "--json"]);
    expect(song.json.kind).toBe("song");
    expect(song.json.facts.channels[0]).toMatchObject({
      id: "pulse1",
      notes: 8,
      source: "mml",
    });
    const inst = await run(repo, ["describe", "instrument/lead"]);
    expect(inst.stdout).toContain("pulse instrument");
    expect((await run(repo, ["describe", "sfx/nope"])).code).toBe(4);
    expect((await run(repo, ["describe"])).code).toBe(2);
  });
});

describe("render and analyze", () => {
  it("render --json has the documented shape and writes out/ files", async () => {
    const { project, repo } = await makeProject();
    const r = await run(repo, ["render", "sfx/coin", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    const e = r.json.renders[0];
    expect(e).toMatchObject({
      cached: false,
      clipped: false,
      path: "out/sfx/coin.wav",
      ref: "sfx/coin",
    });
    expect(e.duration).toBeGreaterThan(0.05);
    expect(e.peakDb).toBeLessThan(0);
    expect(e.rmsDb).toBeLessThan(e.peakDb);
    expect(e.loopStart).toBeNull();
    expect(fs.existsSync(path.join(project, "out", "sfx", "coin.wav"))).toBe(
      true
    );
    const meta = readJson(
      path.join(project, "out", "sfx", "coin.meta.json")
    ) as { hash: string };
    expect(meta.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(r.stderr).toContain("rendering sfx/coin");
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("uses the hash sidecar: unchanged inputs are cached, changed documents and --force render again", async () => {
    const { project, repo } = await makeProject();
    await run(repo, ["render", "sfx/coin"]);
    const again = await run(repo, ["render", "sfx/coin", "--json"]);
    expect(again.json.renders[0].cached).toBe(true);
    expect(again.stderr).not.toContain("rendering");
    expect(
      (await run(repo, ["render", "sfx/coin", "--force", "--json"])).json
        .renders[0].cached
    ).toBe(false);
    const file = path.join(project, "sfx", "coin.json");
    const coin = readJson(file) as { frequency: { start: number } };
    coin.frequency.start += 100;
    writeJson(file, coin);
    expect(
      (await run(repo, ["render", "sfx/coin", "--json"])).json.renders[0].cached
    ).toBe(false);
    expect(
      (await run(repo, ["render", "sfx/coin", "--json"])).json.renders[0].cached
    ).toBe(true);
    const list = await run(repo, ["list", "sfx", "--json"]);
    expect(list.json.sfx[0].render).toMatchObject({ stale: false });
    writeJson(file, { ...coin, volume: 0.3 });
    expect(
      (await run(repo, ["list", "sfx", "--json"])).json.sfx[0].render.stale
    ).toBe(true);
  });

  it("with no refs renders everything, and reports invalid documents per entry with exit 1", async () => {
    const { project, repo } = await makeProject();
    await run(repo, [
      "new",
      "song",
      "title",
      "--mml",
      "pulse1=o4 l8 cdefgab>c",
    ]);
    await run(repo, ["new", "sfx", "zap", "--category", "zap"]);
    const all = await run(repo, ["render", "--json"]);
    expect(all.code).toBe(0);
    expect(all.json.renders.map((x: { ref: string }) => x.ref)).toEqual([
      "sfx/coin",
      "sfx/zap",
      "song/title",
    ]);
    expect(
      fs.existsSync(path.join(project, "out", "songs", "title.events.json"))
    ).toBe(true);
    const zap = readJson(path.join(project, "sfx", "zap.json")) as Record<
      string,
      unknown
    >;
    writeJson(path.join(project, "sfx", "zap.json"), {
      ...zap,
      volume: "nope",
    });
    const bad = await run(repo, ["render", "--json"]);
    expect(bad.code).toBe(1);
    expect(bad.json.ok).toBe(false);
    const failed = bad.json.renders.find(
      (x: { ref: string }) => x.ref === "sfx/zap"
    );
    expect(failed).toMatchObject({ error: { code: "invalid" }, ok: false });
    expect(
      bad.json.renders.find((x: { ref: string }) => x.ref === "sfx/coin").ok
    ).toBe(true);
  });

  it("render --analyze adds the analysis object and --format wav needs no encoder", async () => {
    const { repo } = await makeProject();
    const r = await run(repo, [
      "render",
      "sfx/coin",
      "--analyze",
      "--json",
      "--format",
      "wav",
    ]);
    const a = r.json.renders[0].analysis;
    expect(a).toMatchObject({ channels: 2, sampleRate: 48_000 });
    expect(a.file).toBe("out/sfx/coin.wav");
    expect(a.peakDb).toBeCloseTo(r.json.renders[0].peakDb, 0);
    expect(Array.isArray(a.envelope)).toBe(true);
  });

  it("render rejects instruments, a bad rate and unknown refs", async () => {
    const { repo } = await makeProject();
    expect((await run(repo, ["render", "instrument/lead"])).code).toBe(2);
    expect(
      (await run(repo, ["render", "sfx/coin", "--rate", "100"])).code
    ).toBe(2);
    expect((await run(repo, ["render", "sfx/nope"])).code).toBe(4);
    expect((await run(repo, ["render", "--format", "flac"])).code).toBe(2);
  });

  it("analyze renders when stale, then reuses; --json is the Analysis plus ok", async () => {
    const { repo } = await makeProject();
    const first = await run(repo, ["analyze", "sfx/coin", "--json"]);
    expect(first.code).toBe(0);
    expect(first.json).toMatchObject({
      cached: false,
      ok: true,
      ref: "sfx/coin",
    });
    for (const key of [
      "file",
      "sampleRate",
      "frames",
      "duration",
      "peakDb",
      "rmsDb",
      "lufs",
      "clipped",
      "pitch",
      "spectrum",
      "envelope",
    ]) {
      expect(first.json, key).toHaveProperty(key);
    }
    expect(
      (await run(repo, ["analyze", "sfx/coin", "--json"])).json.cached
    ).toBe(true);
    const human = await run(repo, ["analyze", "sfx/coin"]);
    expect(human.stdout).toContain("level");
    expect(human.stdout).toContain("envelope");
  });

  it("analyze accepts a wav path and refuses ogg and mp3 paths with a fix", async () => {
    const { project, repo } = await makeProject();
    await run(repo, ["render", "sfx/coin"]);
    const file = path.join(project, "out", "sfx", "coin.wav");
    const r = await run(tempDir(), ["analyze", file, "--json"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, sampleRate: 48_000 });
    fs.writeFileSync(path.join(repo, "x.ogg"), "OggS");
    const ogg = await run(repo, ["analyze", "x.ogg"]);
    expect(ogg.code).toBe(1);
    expect(ogg.stderr).toContain("analyze sfx/coin");
    expect((await run(repo, ["analyze", "missing.wav"])).code).toBe(4);
  });

  it.skipIf(STUBBED.includes("tools.encodePng"))(
    "render --images writes the PNGs",
    async () => {
      const { project, repo } = await makeProject();
      const r = await run(repo, ["render", "sfx/coin", "--images", "--json"]);
      expect(r.code).toBe(0);
      const images = r.json.renders[0].images;
      for (const rel of [images.waveform, images.spectrogram]) {
        const bytes = fs.readFileSync(path.join(project, rel));
        expect([...bytes.subarray(0, 8)]).toEqual([
          137, 80, 78, 71, 13, 10, 26, 10,
        ]);
      }
    }
  );

  it.skipIf(STUBBED.includes("core.renderSong"))(
    "renders a looping song with loop points, events and stems",
    async () => {
      const { project, repo } = await makeProject();
      await run(repo, [
        "new",
        "song",
        "title",
        "--mml",
        "pulse1=o4 l8 cdef L gabc",
        "--mml",
        "triangle=o2 l4 c g c g",
      ]);
      const r = await run(repo, ["render", "song/title", "--stems", "--json"]);
      expect(r.code).toBe(0);
      const e = r.json.renders[0];
      expect(e.duration).toBeGreaterThan(1);
      expect(e.loopStart).toBeGreaterThan(0);
      expect(e.loopEnd).toBeGreaterThan(e.loopStart);
      expect(e.stems.length).toBeGreaterThan(0);
      const events = readJson(
        path.join(project, "out", "songs", "title.events.json")
      ) as { events: unknown[]; sampleRate: number };
      expect(events.sampleRate).toBe(48_000);
      expect(events.events.length).toBeGreaterThan(0);
    }
  );
});

describe("export", () => {
  function setExport(project: string, patch: Record<string, unknown>): void {
    const file = path.join(project, "project.json");
    const p = readJson(file) as { export: Record<string, unknown> };
    writeJson(file, { ...p, export: { ...p.export, ...patch } });
  }

  it("--dry-run lists what would change and writes nothing", async () => {
    const { repo } = await makeProject();
    const r = await run(repo, ["export", "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      dryRun: true,
      manifest: "../src/audio.ts",
      ok: true,
      removed: [],
    });
    expect(r.json.written).toEqual(
      expect.arrayContaining([
        "../public/audio/coin.ogg",
        "../src/audio.ts",
        "../public/audio/manifest.json",
      ])
    );
    expect(fs.existsSync(path.join(repo, "public"))).toBe(false);
    expect(
      fs.existsSync(path.join(repo, "audio", "out", "sfx", "coin.wav"))
    ).toBe(false);
  });

  it("writes wav exports, the typed audio.ts and manifest.json, then is a no-op the second time", async () => {
    const { project, repo } = await makeProject();
    setExport(project, { musicFormat: "wav", sfxFormat: "wav" });
    await run(repo, ["new", "sfx", "coin-2", "--category", "coin"]);
    await run(repo, [
      "new",
      "song",
      "title",
      "--mml",
      "pulse1=o4 l8 cdef L gabc",
    ]);
    const r = await run(repo, ["export", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.written).toEqual(
      expect.arrayContaining([
        "../public/audio/coin.wav",
        "../public/audio/coin-2.wav",
        "../public/audio/title.wav",
        "../public/audio/title.events.json",
        "../src/audio.ts",
        "../public/audio/manifest.json",
      ])
    );
    const ts = fs.readFileSync(path.join(repo, "src", "audio.ts"), "utf8");
    expect(ts).toContain("Generated by bleepkit export");
    expect(ts).toContain('coin: "coin.wav"');
    expect(ts).toContain('"coin-2": "coin-2.wav"');
    expect(ts).toContain("export type SfxId");
    const manifest = readJson(
      path.join(repo, "public", "audio", "manifest.json")
    ) as {
      base: string;
      sampleRate: number;
      sfx: Record<string, { duration: number; file: string }>;
      songs: Record<
        string,
        {
          duration: number;
          events?: string;
          file: string;
          loopEnd: number | null;
          loopStart: number | null;
        }
      >;
    };
    expect(manifest.base).toBe("/audio/");
    expect(manifest.sfx.coin).toMatchObject({ file: "coin.wav" });
    expect(manifest.sfx.coin?.duration).toBeGreaterThan(0.05);
    expect(manifest.songs.title).toMatchObject({
      events: "title.events.json",
      file: "title.wav",
    });
    const again = await run(repo, ["export", "--json"]);
    expect(again.json.written).toEqual([]);
    expect(again.json.rendered).toEqual([]);
    expect(again.json.upToDate).toHaveLength(3);
  });

  it("re-exports only what changed and --clean removes files no document produces", async () => {
    const { project, repo } = await makeProject();
    setExport(project, { musicFormat: "wav", sfxFormat: "wav" });
    await run(repo, ["export"]);
    fs.writeFileSync(path.join(repo, "public", "audio", "old.wav"), "x");
    fs.writeFileSync(path.join(repo, "public", "audio", "keep.txt"), "x");
    const dry = await run(repo, ["export", "--clean", "--dry-run", "--json"]);
    expect(dry.json.removed).toEqual(["../public/audio/old.wav"]);
    expect(fs.existsSync(path.join(repo, "public", "audio", "old.wav"))).toBe(
      true
    );
    const real = await run(repo, ["export", "--clean", "--json"]);
    expect(real.json.removed).toEqual(["../public/audio/old.wav"]);
    expect(fs.existsSync(path.join(repo, "public", "audio", "old.wav"))).toBe(
      false
    );
    expect(fs.existsSync(path.join(repo, "public", "audio", "keep.txt"))).toBe(
      true
    );
    const coin = readJson(path.join(project, "sfx", "coin.json")) as {
      envelope: { sustain: number };
    };
    writeJson(path.join(project, "sfx", "coin.json"), {
      ...coin,
      envelope: { ...coin.envelope, sustain: coin.envelope.sustain + 0.2 },
    });
    const changed = await run(repo, ["export", "--json"]);
    expect(changed.json.rendered).toEqual(["sfx/coin"]);
    expect(changed.json.written).toEqual(
      expect.arrayContaining([
        "../public/audio/coin.wav",
        "../public/audio/manifest.json",
      ])
    );
  });

  it("refuses to export (exit 1, nothing written) when a document has errors", async () => {
    const { project, repo } = await makeProject();
    const coin = readJson(path.join(project, "sfx", "coin.json")) as Record<
      string,
      unknown
    >;
    writeJson(path.join(project, "sfx", "coin.json"), {
      ...coin,
      volume: "x",
      wave: 99,
    });
    const r = await run(repo, ["export", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe("invalid");
    expect(r.json.error.message).toContain("sfx/coin");
    expect(fs.existsSync(path.join(repo, "public"))).toBe(false);
  });

  it("refuses an sfx and a song with the same id", async () => {
    const { repo } = await makeProject();
    await run(repo, ["new", "song", "coin", "--mml", "pulse1=c d e"]);
    const r = await run(repo, ["export", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("share the id");
  });

  it("honors --dir and --manifest relative to the cwd and --embed", async () => {
    const { project, repo } = await makeProject();
    setExport(project, { musicFormat: "wav", sfxFormat: "wav" });
    const r = await run(repo, [
      "export",
      "--dir",
      "dist/snd",
      "--manifest",
      "dist/audio.ts",
      "--embed",
      "--json",
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(repo, "dist", "snd", "coin.wav"))).toBe(
      true
    );
    const m = readJson(path.join(repo, "dist", "snd", "manifest.json")) as {
      sfx: { coin: { data?: { category: string } } };
    };
    expect(m.sfx.coin.data?.category).toBe("coin");
    expect(
      fs.readFileSync(path.join(repo, "dist", "audio.ts"), "utf8")
    ).toContain('category: "coin"');
  });

  it.skipIf(!encodersReady)("encodes OGG by default", async () => {
    const { repo } = await makeProject();
    const r = await run(repo, ["export", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const head = fs
      .readFileSync(path.join(repo, "public", "audio", "coin.ogg"))
      .subarray(0, 4)
      .toString("latin1");
    expect(head).toBe("OggS");
  });

  it.skipIf(!(encodersReady && !STUBBED.includes("core.renderSong")))(
    "MP3 music shifts loop points by the encoder delay and warns",
    async () => {
      const { project, repo } = await makeProject();
      await run(repo, [
        "new",
        "song",
        "title",
        "--mml",
        "pulse1=o4 l8 cdef L gabc",
      ]);
      setExport(project, { musicFormat: "wav", sfxFormat: "wav" });
      const wav = await run(repo, ["export", "--json"]);
      expect(wav.code, wav.stderr).toBe(0);
      const base = readJson(
        path.join(repo, "public", "audio", "manifest.json")
      ) as { songs: { title: { loopStart: number; loopEnd: number } } };
      setExport(project, { musicFormat: "mp3", sfxFormat: "wav" });
      const r = await run(repo, ["export", "--json"]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.json.warnings).toContain(
        "MP3 loop points are approximate; use OGG for seamless loops"
      );
      const mp3 = readJson(
        path.join(repo, "public", "audio", "manifest.json")
      ) as {
        songs: { title: { file: string; loopStart: number; loopEnd: number } };
      };
      expect(mp3.songs.title.file).toBe("title.mp3");
      expect(
        mp3.songs.title.loopStart - base.songs.title.loopStart
      ).toBeCloseTo(1105 / 48_000, 5);
      expect(mp3.songs.title.loopEnd - base.songs.title.loopEnd).toBeCloseTo(
        1105 / 48_000,
        5
      );
    }
  );
});

describe("help and play", () => {
  it("help formats prints the document formats and MML; --json wraps the text", async () => {
    const r = await run(tempDir(), ["help", "formats"]);
    expect(r.code).toBe(0);
    for (const needle of [
      "PROJECT",
      "SFX",
      "INSTRUMENT",
      "SONG",
      "MML",
      "EFFECTS",
      "ROWS",
      "nes | gameboy",
    ]) {
      expect(r.stdout, needle).toContain(needle);
    }
    expect(r.stdout).not.toContain("—");
    const mml = await run(tempDir(), ["help", "formats", "mml", "--json"]);
    expect(mml.json).toMatchObject({
      ok: true,
      section: "mml",
      topic: "formats",
    });
    expect(mml.json.text).toContain("o<0-8>");
    expect((await run(tempDir(), ["help", "formats", "nope"])).code).toBe(2);
    expect((await run(tempDir(), ["help", "workflow"])).stdout).toContain(
      "analyze"
    );
    expect((await run(tempDir(), ["help", "render"])).stdout).toContain(
      "--analyze"
    );
  });

  it("play exits 4 with a fix when no studio answers", async () => {
    const { repo } = await makeProject();
    const r = await run(repo, [
      "play",
      "sfx/coin",
      "--studio",
      "http://127.0.0.1:1",
      "--json",
    ]);
    expect(r.code).toBe(4);
    expect(r.json.error.code).toBe("not-found");
    expect(r.json.error.hint).toContain("bleepkit studio");
  });
});
