import fs from "node:fs";
import path from "node:path";
import { CHIP_IDS } from "@bleepkit/core";
import { describe, expect, it } from "vitest";
import {
  makeProject,
  readJson,
  readWav,
  run,
  tempDir,
  wavLevels,
  writeJson,
} from "./helpers.ts";

/** The character the house rules forbid in generated text, written as a code so this file has none. */
const EM_DASH = String.fromCharCode(0x20_14);

/** What `render --json` and `analyze --json` report must match the WAV that was written, measured here from its bytes. */
function expectMatchesWav(
  reported: { duration: number; peakDb: number; rmsDb: number },
  file: string
): void {
  const wav = readWav(file);
  const levels = wavLevels(wav);
  expect(reported.duration).toBeCloseTo(wav.frames / wav.sampleRate, 5);
  expect(reported.peakDb).toBeCloseTo(levels.peakDb, 1);
  expect(reported.rmsDb).toBeCloseTo(levels.rmsDb, 1);
}

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

  it("every command has help with an example, and asking for help changes nothing on disk", async () => {
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
      const dir = tempDir();
      // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, the failing name is reported by the assertion
      const r = await run(dir, [name, "--help"]);
      expect(r.code, name).toBe(0);
      expect(r.stdout, name).toContain("Examples:");
      expect(r.stdout, name).toContain(`bleepkit ${name}`);
      expect(fs.readdirSync(dir), name).toEqual([]);
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

  it("walks past a project.json that is not a Bleepkit project (numeric version and a chip or export are needed)", async () => {
    const { project, repo } = await makeProject();
    const web = path.join(repo, "web");
    // a file with a chip but a string version, and one with a number but neither chip nor export
    for (const lookalike of [
      { chip: "nes", name: "web", version: "1.0.0" },
      { name: "web", version: 3 },
    ]) {
      writeJson(path.join(web, "project.json"), lookalike);
      // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, the shared folder changes between runs
      const r = await run(web, ["list", "--json"]);
      expect(r.code, JSON.stringify(lookalike)).toBe(0);
      expect(r.json.root).toBe(project);
    }
    writeJson(path.join(web, "project.json"), { chip: "nes", version: 1 });
    expect((await run(web, ["list", "--json"])).json.root).toBe(web);
  });

  it("exits 3 when project.json cannot be read as JSON", async () => {
    const { project } = await makeProject();
    fs.writeFileSync(path.join(project, "project.json"), "{ nope");
    const r = await run(tempDir(), ["list", "--project", project, "--json"]);
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ error: { code: "no-project" }, ok: false });
    expect(r.json.error.message).toContain("not valid JSON");
  });

  it("exits 5 with code write when the output cannot be written", async () => {
    const { project, repo } = await makeProject();
    // init made out/ a folder: put a file where it should be
    fs.rmSync(path.join(project, "out"), { recursive: true });
    fs.writeFileSync(path.join(project, "out"), "a file, not a folder");
    const r = await run(repo, ["render", "sfx/coin", "--json"]);
    expect(r.code).toBe(5);
    expect(r.json).toMatchObject({ error: { code: "write" }, ok: false });
  });

  it("every command prints exactly one JSON object on stdout with --json", async () => {
    const { repo } = await makeProject();
    const commands = [
      ["new", "sfx", "jump", "--category", "jump"],
      ["new", "instrument", "pluck", "--kind", "pulse"],
      ["new", "song", "title", "--mml", "pulse1=o4 c d e"],
      ["mutate", "sfx/jump"],
      ["validate"],
      ["list"],
      ["render", "sfx/jump"],
      ["analyze", "sfx/jump"],
      ["describe", "sfx/jump"],
      ["export", "--dry-run"],
      ["help"],
      ["help", "workflow"],
      ["help", "formats", "mml"],
    ];
    for (const args of commands) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, each command builds on the files of the one before
      const r = await run(repo, [...args, "--json"]);
      expect(r.code, args.join(" ")).toBe(0);
      expect(r.stdout.trim().split("\n"), args.join(" ")).toHaveLength(1);
      expect(r.json, args.join(" ")).toMatchObject({ ok: true });
    }
    const init = await run(tempDir(), ["init", "--json"]);
    expect(init.stdout.trim().split("\n")).toHaveLength(1);
    expect(init.json).toMatchObject({ ok: true });
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
    for (const file of r.json.files) {
      expect(fs.existsSync(path.join(repo, "audio", file)), file).toBe(true);
    }
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

  it("init writes a valid starter project, with a sfx that renders audibly, for every chip", async () => {
    for (const chip of CHIP_IDS) {
      const repo = tempDir();
      // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, the failing chip is named by the assertions
      const init = await run(repo, ["init", "--chip", chip, "--json"]);
      expect(init.code, chip).toBe(0);
      const project = readJson(path.join(repo, "audio", "project.json")) as {
        chip: string;
      };
      expect(project.chip, chip).toBe(chip);
      const validate = await run(repo, ["validate", "--json"]);
      expect(validate.code, `${chip}: ${JSON.stringify(validate.json)}`).toBe(
        0
      );
      const render = await run(repo, ["render", "sfx/coin", "--json"]);
      expect(render.code, `${chip}: ${render.stderr}`).toBe(0);
      const { peakDb } = render.json.renders[0];
      expect(peakDb, chip).toBeLessThan(0);
      expect(peakDb, chip).toBeGreaterThan(-40);
    }
  });

  it("new instrument --preset bass picks the chip's bass voice and bass-pulse a pulse, and init writes that bass", async () => {
    const { repo } = await makeProject();
    const make = async (id: string, chip: string, preset: string) =>
      run(repo, [
        "new",
        "instrument",
        id,
        "--chip",
        chip,
        "--preset",
        preset,
        "--json",
      ]);
    // the voice a bass wants on each chip, and what is in it (not the exact numbers)
    const voices = {
      adlib: "fm",
      c64: "sid",
      custom: "sid",
      gameboy: "wave",
      genesis: "fm",
      nes: "triangle",
      snes: "sample",
    };
    for (const [chip, kind] of Object.entries(voices)) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, the failing chip is named by the assertions
      const r = await make(`bass-${chip}`, chip, "bass");
      expect(r.code, chip).toBe(0);
      expect(r.json.doc, chip).toMatchObject({ chip, kind });
    }
    const wave = (await make("fat", "gameboy", "bass")).json.doc.wave.table;
    expect(wave).toHaveLength(32);
    expect(Math.max(...wave)).toBe(15);
    expect(Math.min(...wave)).toBe(0);
    const double = await make("double", "nes", "bass-pulse");
    expect(double.json.doc).toMatchObject({
      kind: "pulse",
      pulse: { duty: 0.5 },
    });
    expect(double.json.doc.volume).toBeLessThan(0.5);
    // the c64 has no pulse channel to double on
    expect((await make("nope", "c64", "bass-pulse")).code).toBe(2);
    // init writes the same bass for the chip
    const dir = tempDir();
    expect((await run(dir, ["init", "--chip", "gameboy", "--json"])).code).toBe(
      0
    );
    const starter = readJson(
      path.join(dir, "audio", "instruments", "bass.json")
    ) as {
      kind: string;
      wave: { table: number[] };
    };
    expect(starter.kind).toBe("wave");
    expect(starter.wave.table).toEqual(wave);
  });

  it("init rejects a chip it does not know with exit 2 and lists the chips it does", async () => {
    const r = await run(tempDir(), ["init", "--chip", "amiga"]);
    expect(r.code).toBe(2);
    for (const chip of CHIP_IDS) {
      expect(r.stderr, chip).toContain(chip);
    }
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
    expect(r.json.description).toContain("jump");
    expect(r.json.doc).toMatchObject({
      category: "jump",
      chip: "nes",
      version: 1,
    });
    // the document on disk is the one reported, and the id lives in the file name only
    const onDisk = readJson(path.join(project, "sfx", "jump.json")) as {
      id?: string;
    };
    expect(onDisk).toEqual(r.json.doc);
    expect(onDisk.id).toBeUndefined();
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

  it("new sfx is deterministic for a given seed, and a different seed gives a different sound", async () => {
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
    const c = await run(repo, [
      "new",
      "sfx",
      "c",
      "--category",
      "laser",
      "--seed",
      "6",
      "--json",
    ]);
    expect(c.json.doc.seed).toBe(6);
    expect(c.json.doc.frequency).not.toEqual(a.json.doc.frequency);
  });

  it("new instrument and new song write valid documents with the requested preset, tempo, MML and template", async () => {
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
    // each preset has the character its name promises (not its exact numbers)
    const preset = async (name: string) =>
      (
        await run(repo, [
          "new",
          "instrument",
          `i-${name}`,
          "--kind",
          "pulse",
          "--preset",
          name,
          "--json",
        ])
      ).json.doc.envelope as {
        attack: number;
        decay: number;
        sustain: number;
      };
    const bell = await preset("bell");
    expect(bell.sustain).toBeLessThan(0.2);
    expect(bell.decay).toBeGreaterThan(0.5);
    expect((await preset("pad")).attack).toBeGreaterThan(0.1);
    expect((await preset("bass")).sustain).toBeGreaterThanOrEqual(0.5);
    const drums = await preset("drums");
    expect(drums.sustain).toBe(0);
    expect(drums.decay).toBeLessThan(0.2);
    expect(inst.json.doc.envelope).toEqual(bell);
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
    // everything written above is a valid document
    const validate = await run(repo, ["validate", "--json"]);
    expect(validate.code, JSON.stringify(validate.json)).toBe(0);
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
    const [doc] = bad.json.documents;
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
    const [doc] = r.json.documents;
    expect(doc.ok).toBe(false);
    expect(doc.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("lead"),
        path: "/channels/0/instrument",
        severity: "error",
      })
    );
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
    expect(a.json.results[0].description).toContain("coin");
    // a variant is the same kind of sound with some parameters moved
    const source = readJson(path.join(project, "sfx", "coin.json")) as Record<
      string,
      unknown
    >;
    const variant = readJson(
      path.join(project, "sfx", "coin-m1.json")
    ) as Record<string, unknown>;
    expect(variant).toMatchObject({ category: "coin", chip: "nes" });
    expect({ ...variant, name: "" }).not.toEqual({ ...source, name: "" });
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
    // --amount 0 moves nothing
    await run(repo, [
      "mutate",
      "sfx/coin",
      "--amount",
      "0",
      "--out",
      "coin-same",
    ]);
    const same = readJson(
      path.join(project, "sfx", "coin-same.json")
    ) as Record<string, unknown>;
    expect({ ...same, name: "" }).toEqual({ ...source, name: "" });
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
    expect(sfx.json.description).toContain("coin");
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
  it("render --json reports what the written WAV contains and writes the hash sidecar", async () => {
    const { project, repo } = await makeProject();
    const r = await run(repo, ["render", "sfx/coin", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    const [e] = r.json.renders;
    expect(e).toMatchObject({
      cached: false,
      clipped: false,
      path: "out/sfx/coin.wav",
      ref: "sfx/coin",
    });
    expect(e.rmsDb).toBeLessThan(e.peakDb);
    expect(e.loopStart).toBeNull();
    expect(e.loopEnd).toBeNull();
    // the numbers describe the file that was written, whose format section 8 fixes: 16-bit WAV at the project's rate
    const wav = readWav(path.join(project, "out", "sfx", "coin.wav"));
    expect(wav).toMatchObject({
      bitsPerSample: 16,
      channels: 2,
      sampleRate: 48_000,
    });
    expect(wav.loop).toBeNull();
    expectMatchesWav(e, path.join(project, "out", "sfx", "coin.wav"));
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
    const [rendered] = (await run(repo, ["render", "sfx/coin", "--json"])).json
      .renders;
    expect(list.json.sfx[0].render).toEqual({
      clipped: false,
      duration: rendered.duration,
      path: "out/sfx/coin.wav",
      peakDb: rendered.peakDb,
      stale: false,
    });
    writeJson(file, { ...coin, volume: 0.3 });
    expect(
      (await run(repo, ["list", "sfx", "--json"])).json.sfx[0].render.stale
    ).toBe(true);
  });

  it("an edited instrument makes the songs that use it stale, and a changed project master makes sfx stale and louder or quieter", async () => {
    const { project, repo } = await makeProject();
    await run(repo, [
      "new",
      "song",
      "title",
      "--mml",
      "pulse1=o4 l8 cdef L gabc",
    ]);
    const first = await run(repo, ["render", "--json"]);
    expect(
      first.json.renders.map((r: { cached: boolean }) => r.cached)
    ).toEqual([false, false]);
    const peaks = Object.fromEntries(
      first.json.renders.map((r: { peakDb: number; ref: string }) => [
        r.ref,
        r.peakDb,
      ])
    );

    const leadFile = path.join(project, "instruments", "lead.json");
    const lead = readJson(leadFile) as { envelope: { sustain: number } };
    writeJson(leadFile, {
      ...lead,
      envelope: { ...lead.envelope, sustain: 0.2 },
    });
    const listed = await run(repo, ["list", "--json"]);
    expect(listed.json.songs[0].render.stale).toBe(true);
    expect(listed.json.sfx[0].render.stale).toBe(false);
    const afterInstrument = await run(repo, ["render", "--json"]);
    const cachedByRef = Object.fromEntries(
      afterInstrument.json.renders.map(
        (r: { cached: boolean; ref: string }) => [r.ref, r.cached]
      )
    );
    expect(cachedByRef).toEqual({ "sfx/coin": true, "song/title": false });

    // architecture.md 3.8: the project master volume applies to sfx, songs keep their own master
    const projectFile = path.join(project, "project.json");
    const p = readJson(projectFile) as { master: { volume: number } };
    writeJson(projectFile, {
      ...p,
      master: { ...p.master, volume: p.master.volume / 2 },
    });
    const afterMaster = await run(repo, ["render", "sfx/coin", "--json"]);
    expect(afterMaster.json.renders[0].cached).toBe(false);
    expect(afterMaster.json.renders[0].peakDb - peaks["sfx/coin"]).toBeCloseTo(
      -6.02,
      0
    );
    const song = await run(repo, ["render", "song/title", "--json"]);
    expect(
      Math.abs(song.json.renders[0].peakDb - peaks["song/title"])
    ).toBeLessThan(1);
  });

  it("renders the same bytes for the same inputs, and --seed (the run's seed) changes a noise sound", async () => {
    const { project, repo } = await makeProject();
    await run(repo, ["new", "sfx", "boom", "--category", "explosion"]);
    const wav = path.join(project, "out", "sfx", "boom.wav");
    const render = async (...flags: string[]): Promise<string> => {
      const r = await run(repo, [
        "render",
        "sfx/boom",
        "--force",
        ...flags,
        "--json",
      ]);
      expect(r.code, r.stderr).toBe(0);
      return fs.readFileSync(wav).toString("base64");
    };
    const normal = await render();
    expect(readJson(path.join(project, "sfx", "boom.json"))).toMatchObject({
      wave: "noise",
    });
    expect(await render()).toBe(normal);
    const seeded = await render("--seed", "2");
    expect(seeded).not.toBe(normal);
    expect(await render("--seed", "2")).toBe(seeded);
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

  it("render --analyze adds the analysis object, measured from the WAV that was written", async () => {
    const { project, repo } = await makeProject();
    const r = await run(repo, ["render", "sfx/coin", "--analyze", "--json"]);
    const [entry] = r.json.renders;
    const file = path.join(project, "out", "sfx", "coin.wav");
    const wav = readWav(file);
    expect(entry.analysis).toMatchObject({
      channels: 2,
      file: "out/sfx/coin.wav",
      frames: wav.frames,
      sampleRate: 48_000,
    });
    expectMatchesWav(entry.analysis, file);
    expect(entry.analysis.envelope.length).toBeGreaterThan(0);
  });

  it("render --format ogg and mp3 write the encoded file next to the WAV master", async () => {
    const { project, repo } = await makeProject();
    const ogg = await run(repo, [
      "render",
      "sfx/coin",
      "--format",
      "ogg",
      "--json",
    ]);
    expect(ogg.code, ogg.stderr).toBe(0);
    expect(ogg.json.renders[0].path).toBe("out/sfx/coin.ogg");
    const oggBytes = fs.readFileSync(
      path.join(project, "out", "sfx", "coin.ogg")
    );
    expect(oggBytes.subarray(0, 4).toString("latin1")).toBe("OggS");
    const mp3 = await run(repo, [
      "render",
      "sfx/coin",
      "--format",
      "mp3",
      "--json",
    ]);
    expect(mp3.code, mp3.stderr).toBe(0);
    expect(mp3.json.renders[0].path).toBe("out/sfx/coin.mp3");
    const mp3Bytes = fs.readFileSync(
      path.join(project, "out", "sfx", "coin.mp3")
    );
    // an MP3 frame header starts with 11 set bits (or an ID3 tag comes first)
    const [b0, b1] = mp3Bytes;
    expect(
      mp3Bytes.subarray(0, 3).toString("latin1") === "ID3" ||
        (b0 === 0xff && (b1 ?? 0) >= 0xe0)
    ).toBe(true);
    // the WAV master is always there
    expect(fs.existsSync(path.join(project, "out", "sfx", "coin.wav"))).toBe(
      true
    );
  });

  it("render --rate sets the sample rate of the WAV, and a different rate is a different render", async () => {
    const { project, repo } = await makeProject();
    const wavFile = path.join(project, "out", "sfx", "coin.wav");
    const at48 = await run(repo, ["render", "sfx/coin", "--json"]);
    const at44 = await run(repo, [
      "render",
      "sfx/coin",
      "--rate",
      "44100",
      "--json",
    ]);
    expect(at44.json.renders[0]).toMatchObject({ cached: false, rate: 44_100 });
    expect(readWav(wavFile).sampleRate).toBe(44_100);
    expect(at44.json.renders[0].duration).toBeCloseTo(
      at48.json.renders[0].duration,
      2
    );
    const back = await run(repo, ["render", "sfx/coin", "--json"]);
    expect(back.json.renders[0]).toMatchObject({ cached: false, rate: 48_000 });
    expect(readWav(wavFile).sampleRate).toBe(48_000);
  });

  it("render rejects instruments, a bad rate and unknown refs", async () => {
    const { repo } = await makeProject();
    expect((await run(repo, ["render", "instrument/lead"])).code).toBe(2);
    expect(
      (await run(repo, ["render", "sfx/coin", "--rate", "100"])).code
    ).toBe(2);
    // --loops counts extra passes: at least 1 (architecture.md 6.2)
    const song = await run(repo, [
      "new",
      "song",
      "title",
      "--mml",
      "pulse1=o4 c L d",
    ]);
    expect(song.code, song.stderr).toBe(0);
    expect(
      (await run(repo, ["render", "song/title", "--loops", "0"])).code
    ).toBe(2);
    expect((await run(repo, ["render", "sfx/coin", "--tail", "-1"])).code).toBe(
      2
    );
    expect((await run(repo, ["render", "sfx/nope"])).code).toBe(4);
    expect((await run(repo, ["render", "--format", "flac"])).code).toBe(2);
  });

  it("analyze --json is the Analysis of the written WAV plus ok, and reuses a current render", async () => {
    const { project, repo } = await makeProject();
    const first = await run(repo, ["analyze", "sfx/coin", "--json"]);
    expect(first.code).toBe(0);
    const file = path.join(project, "out", "sfx", "coin.wav");
    const wav = readWav(file);
    expect(first.json).toMatchObject({
      cached: false,
      channels: 2,
      clipped: { first: null, frames: 0 },
      file: "out/sfx/coin.wav",
      frames: wav.frames,
      ok: true,
      ref: "sfx/coin",
      sampleRate: 48_000,
    });
    expectMatchesWav(first.json, file);
    for (const band of ["lowDb", "midDb", "highDb"]) {
      expect(typeof first.json.spectrum.bands[band], band).toBe("number");
    }
    expect(first.json.envelope.length).toBeGreaterThan(0);
    expect(first.json.envelope.length).toBeLessThanOrEqual(1000);
    expect(
      (await run(repo, ["analyze", "sfx/coin", "--json"])).json.cached
    ).toBe(true);
    const human = await run(repo, ["analyze", "sfx/coin"]);
    expect(human.stdout).toContain("level");
    expect(human.stdout).toContain("envelope");
  });

  it("analyze renders again when the document changed, and reports the new sound", async () => {
    const { project, repo } = await makeProject();
    const file = path.join(project, "sfx", "coin.json");
    const coin = readJson(file) as Record<string, unknown> & {
      envelope: Record<string, number>;
    };
    // a square (it has a volume, unlike the NES triangle) whose envelope decays in 0.18 s, then in 0.36 s
    const square = { ...coin, volume: 0.55, wave: "square" };
    writeJson(file, {
      ...square,
      envelope: { attack: 0, decay: 0.18, punch: 0, sustain: 0 },
    });
    const short = await run(repo, ["analyze", "sfx/coin", "--json"]);
    writeJson(file, {
      ...square,
      envelope: { attack: 0, decay: 0.36, punch: 0, sustain: 0 },
    });
    const long = await run(repo, ["analyze", "sfx/coin", "--json"]);
    expect(short.json.cached).toBe(false);
    expect(long.json.cached).toBe(false);
    expect(short.json.duration).toBeGreaterThan(0.17);
    expect(short.json.duration).toBeLessThan(0.24);
    expect(long.json.duration).toBeGreaterThan(0.34);
    expect(long.json.duration).toBeLessThan(0.42);
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

  it("render --images writes the PNGs", async () => {
    const { project, repo } = await makeProject();
    const r = await run(repo, ["render", "sfx/coin", "--images", "--json"]);
    expect(r.code).toBe(0);
    const [{ images }] = r.json.renders;
    expect(images).toEqual({
      spectrogram: "out/analysis/coin.spectrogram.png",
      waveform: "out/analysis/coin.waveform.png",
    });
    for (const rel of [images.waveform, images.spectrogram]) {
      const bytes = fs.readFileSync(path.join(project, rel));
      expect([...bytes.subarray(0, 8)]).toEqual([
        137, 80, 78, 71, 13, 10, 26, 10,
      ]);
    }
  });

  it("renders a looping song with the loop points, events and stems its MML and tempo imply", async () => {
    const { project, repo } = await makeProject();
    // 120 bpm and l8: a note lasts 0.25 s (12000 frames at 48 kHz). The intro "cdef" is 1 s, the loop "gabc" 1 s.
    await run(repo, [
      "new",
      "song",
      "title",
      "--mml",
      "pulse1=o4 l8 cdef L gabc",
    ]);
    const r = await run(repo, ["render", "song/title", "--stems", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const [e] = r.json.renders;
    // architecture.md 6.2: the render holds the intro and two passes, and the loop is the second pass; plus 1 s of tail
    expect(e).toMatchObject({ duration: 4, loopEnd: 3, loopStart: 2 });

    const master = readWav(path.join(project, "out", "songs", "title.wav"));
    expect(master.frames).toBe(4 * 48_000);
    // architecture.md 8: the smpl chunk holds the same loop, in frames (the stored end is the last frame of the loop)
    expect(master.loop).toEqual({ end: 3 * 48_000 - 1, start: 2 * 48_000 });

    const events = readJson(
      path.join(project, "out", "songs", "title.events.json")
    ) as {
      duration: number;
      events: {
        channelId: string;
        frame: number;
        note: number;
        type: string;
      }[];
      loopEnd: number;
      loopStart: number;
      sampleRate: number;
    };
    expect(events).toMatchObject({
      duration: 4,
      loopEnd: 3,
      loopStart: 2,
      sampleRate: 48_000,
    });
    const notes = events.events
      .filter((x) => x.type === "noteOn" && x.channelId === "pulse1")
      .map((x) => [x.frame, x.note]);
    // MIDI numbers of c d e f g a b c in octave 4 (c4 = 60), then the loop body again: g a b c
    expect(notes).toEqual([
      [0, 60],
      [12_000, 62],
      [24_000, 64],
      [36_000, 65],
      [48_000, 67],
      [60_000, 69],
      [72_000, 71],
      [84_000, 60],
      [96_000, 67],
      [108_000, 69],
      [120_000, 71],
      [132_000, 60],
    ]);
    expect(events.events.filter((x) => x.type === "loop")).toHaveLength(1);

    // one stem per NES channel, each as long as the master; only the channel that plays is not silent
    const channels = ["pulse1", "pulse2", "triangle", "noise"];
    expect(e.stems).toEqual(
      channels.map((c) => `out/songs/title.stem-${c}.wav`)
    );
    for (const c of channels) {
      const stem = readWav(path.join(project, `out/songs/title.stem-${c}.wav`));
      expect(stem.channels, c).toBe(1);
      expect(stem.frames, c).toBe(master.frames);
      expect(
        stem.samples.every((v) => v === 0),
        c
      ).toBe(c !== "pulse1");
    }
  });

  it("--loops adds passes after the loop and --tail adds release time, without moving the loop", async () => {
    const { repo } = await makeProject();
    await run(repo, [
      "new",
      "song",
      "title",
      "--mml",
      "pulse1=o4 l8 cdef L gabc",
    ]);
    const duration = async (...flags: string[]) => {
      const r = await run(repo, ["render", "song/title", ...flags, "--json"]);
      expect(r.code, r.stderr).toBe(0);
      return r.json.renders[0];
    };
    // intro 1 s + passes of 1 s + tail
    expect(await duration("--tail", "0")).toMatchObject({
      duration: 3,
      loopEnd: 3,
      loopStart: 2,
    });
    expect(await duration("--loops", "2", "--tail", "0")).toMatchObject({
      duration: 4,
      loopEnd: 3,
      loopStart: 2,
    });
    expect(await duration("--loops", "2", "--tail", "2")).toMatchObject({
      duration: 6,
      loopEnd: 3,
      loopStart: 2,
    });
  });

  it("analyze reports the loop of a song, a clean seam for a repeating melody, and trims the pitch track unless --pitch", async () => {
    const { repo } = await makeProject();
    await run(repo, [
      "new",
      "song",
      "title",
      "--mml",
      "pulse1=o4 l8 cdef L gabc",
    ]);
    const a = await run(repo, ["analyze", "song/title", "--json"]);
    expect(a.code, a.stderr).toBe(0);
    expect(a.json.loop).toMatchObject({ end: 3, start: 2 });
    // identical audio before the loop end and before the loop start: below -40 dB is clean (AGENTS.md)
    expect(a.json.loop.seamDiffDb).toBeLessThan(-40);
    // 4 s at a 512 frame hop is about 375 entries: 200 in --json, all of them with --pitch
    expect(a.json.pitch.track).toHaveLength(200);
    const full = await run(repo, [
      "analyze",
      "song/title",
      "--pitch",
      "--json",
    ]);
    expect(full.json.pitch.track.length).toBeGreaterThan(300);
  });
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
    expect(manifest.sampleRate).toBe(48_000);
    expect(manifest.sfx.coin).toMatchObject({ file: "coin.wav" });
    expect(manifest.songs.title).toMatchObject({
      events: "title.events.json",
      file: "title.wav",
    });
    // the manifest describes the exported files: durations and loop points agree with the WAV chunks (section 8)
    const audio = path.join(repo, "public", "audio");
    const coin = readWav(path.join(audio, "coin.wav"));
    expect(manifest.sfx.coin?.duration).toBeCloseTo(
      coin.frames / coin.sampleRate,
      5
    );
    const title = readWav(path.join(audio, "title.wav"));
    expect(manifest.songs.title?.duration).toBeCloseTo(
      title.frames / title.sampleRate,
      5
    );
    expect(title.loop).not.toBeNull();
    expect(manifest.songs.title?.loopStart).toBeCloseTo(
      (title.loop?.start ?? 0) / title.sampleRate,
      5
    );
    expect(manifest.songs.title?.loopEnd).toBeCloseTo(
      ((title.loop?.end ?? 0) + 1) / title.sampleRate,
      5
    );
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

  it("honors --dir, --manifest, --sfx-format, --music-format and --embed over the project's settings, relative to the cwd", async () => {
    const { repo } = await makeProject();
    const r = await run(repo, [
      "export",
      "--dir",
      "dist/snd",
      "--manifest",
      "dist/audio.ts",
      "--sfx-format",
      "wav",
      "--music-format",
      "wav",
      "--embed",
      "--json",
    ]);
    expect(r.code, r.stderr).toBe(0);
    // the project says ogg; the flag wins
    expect(fs.existsSync(path.join(repo, "dist", "snd", "coin.wav"))).toBe(
      true
    );
    expect(fs.existsSync(path.join(repo, "dist", "snd", "coin.ogg"))).toBe(
      false
    );
    const m = readJson(path.join(repo, "dist", "snd", "manifest.json")) as {
      sfx: { coin: { data?: { category: string } } };
    };
    expect(m.sfx.coin.data?.category).toBe("coin");
    expect(
      fs.readFileSync(path.join(repo, "dist", "audio.ts"), "utf8")
    ).toContain('category: "coin"');
  });

  it("encodes OGG by default", async () => {
    const { repo } = await makeProject();
    const r = await run(repo, ["export", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const head = fs
      .readFileSync(path.join(repo, "public", "audio", "coin.ogg"))
      .subarray(0, 4)
      .toString("latin1");
    expect(head).toBe("OggS");
  });

  it("MP3 music shifts loop points by the encoder delay and warns", async () => {
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
    expect(mp3.songs.title.loopStart - base.songs.title.loopStart).toBeCloseTo(
      1105 / 48_000,
      5
    );
    expect(mp3.songs.title.loopEnd - base.songs.title.loopEnd).toBeCloseTo(
      1105 / 48_000,
      5
    );
  });
});

describe("help", () => {
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
    expect(r.stdout).not.toContain(EM_DASH);
    // an agent learns the chip ids from here: all of core's must be listed
    for (const chip of CHIP_IDS) {
      expect(r.stdout, chip).toContain(chip);
    }
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
});
