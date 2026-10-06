import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeProject, readJson, run } from "./helpers.ts";

/* A MIDI file built byte by byte: 96 ticks per quarter, 120 BPM (500000 us per quarter), so a beat is 0.5 s, a row (4 per
   beat) is 0.125 s and one row is 6000 frames at 48 kHz. */

function vlq(n: number): number[] {
  const out = [n % 128];
  let rest = Math.floor(n / 128);
  while (rest > 0) {
    out.unshift((rest % 128) + 128);
    rest = Math.floor(rest / 128);
  }
  return out;
}

function ev(delta: number, ...data: number[]): number[] {
  return [...vlq(delta), ...data];
}

function track(...events: number[][]): number[] {
  const body = [...events.flat(), ...ev(0, 0xff, 0x2f, 0)];
  const n = body.length;
  return [
    ...[..."MTrk"].map((c) => c.charCodeAt(0)),
    0,
    0,
    Math.floor(n / 256),
    n % 256,
    ...body,
  ];
}

const HEADER = [...[..."MThd"].map((c) => c.charCodeAt(0)), 0, 0, 0, 6];

/** Format 1, 96 ppq: a tempo track, a melody on channel 1, a bass on channel 2 and drums on channel 10. */
function tune(): Uint8Array {
  const melody = [72, 74, 76, 77, 79, 77, 76, 74].flatMap((n, i) => [
    ev(i === 0 ? 0 : 48, 0x90, n, 100),
    ev(48, 0x80, n, 0),
  ]);
  const bass = [36, 36, 43, 41, 36, 36, 43, 41].flatMap((n, i) => [
    ev(i === 0 ? 0 : 48, 0x91, n, 110),
    ev(48, 0x81, n, 0),
  ]);
  // kick and hat together on beat 1, snare on beat 2, kick on beat 3
  const drums = [
    ev(0, 0x99, 36, 120),
    ev(0, 0x99, 42, 80),
    ev(96, 0x99, 38, 110),
    ev(96, 0x99, 36, 120),
  ];
  const tracks = [
    track(ev(0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20)),
    track(...melody),
    track(...bass),
    track(...drums),
  ];
  return Uint8Array.from([
    ...HEADER,
    0,
    1,
    0,
    tracks.length,
    0,
    96,
    ...tracks.flat(),
  ]);
}

/** One melodic part: a C major chord on the first beat (96 ticks), then a single high note. */
function chordTune(): Uint8Array {
  const body = [
    ...[60, 64, 67].map((n) => ev(0, 0x90, n, 100)),
    ...[60, 64, 67].map((n, i) => ev(i === 0 ? 96 : 0, 0x80, n, 0)),
    ev(0, 0x90, 72, 100),
    ev(96, 0x80, 72, 0),
  ];
  const t = track(...body);
  return Uint8Array.from([...HEADER, 0, 0, 0, 1, 0, 96, ...t]);
}

function writeTune(dir: string, name = "tune.mid"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, tune());
  return file;
}

interface Imported {
  chip: string;
  doc: { channels: { id: string; instrument: string | null }[]; tempo: number };
  instruments: { created: boolean; id: string }[];
  issues: { message: string; path: string; severity: string }[];
  ok: boolean;
  parts: { name: string | null; target: string | null }[];
  path: string;
}

describe("bleepkit import", () => {
  it("puts the melody, bass and drums on pulse1, triangle and noise, and writes instruments next to the song", async () => {
    const { project, repo } = await makeProject();
    writeTune(repo);
    const r = await run(repo, ["import", "tune.mid", "--json"]);
    const out = r.json as Imported;
    expect(out).toMatchObject({
      chip: "nes",
      ok: true,
      path: "songs/tune.json",
    });
    expect(out.doc.tempo).toBe(120);
    expect(out.parts.map((p) => p.target)).toEqual([
      "pulse1",
      "triangle",
      "noise",
    ]);
    expect(out.instruments.map((i) => [i.id, i.created]).sort()).toEqual([
      ["midi-nes-bass", true],
      ["midi-nes-drums", true],
      ["midi-nes-lead", true],
    ]);
    for (const id of ["midi-nes-bass", "midi-nes-drums", "midi-nes-lead"]) {
      expect(
        fs.existsSync(path.join(project, "instruments", `${id}.json`))
      ).toBe(true);
    }
    const song = readJson(path.join(project, "songs", "tune.json")) as {
      channels: { id: string; instrument: string | null }[];
    };
    expect(
      Object.fromEntries(song.channels.map((c) => [c.id, c.instrument]))
    ).toMatchObject({
      noise: "midi-nes-drums",
      pulse1: "midi-nes-lead",
      triangle: "midi-nes-bass",
    });
    // the hat shares a row with the kick on a one-drum channel: one hit is reported
    expect(out.issues.map((i) => i.message).join("\n")).toContain(
      "noise: 1 drum hits dropped"
    );
    const v = await run(repo, ["validate", "--json"]);
    expect(v.code, v.stdout).toBe(0);
  });

  it("renders with the notes where the file put them", async () => {
    const { project, repo } = await makeProject();
    writeTune(repo);
    await run(repo, ["import", "tune.mid", "--no-loop", "--json"]);
    const r = await run(repo, ["render", "song/tune", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const events = readJson(
      path.join(project, "out", "songs", "tune.events.json")
    ) as {
      events: {
        channelId: string;
        frame: number;
        note: number;
        type: string;
      }[];
    };
    const on = (id: string) =>
      events.events
        .filter((e) => e.type === "noteOn" && e.channelId === id)
        .map((e) => [e.frame, e.note]);
    // melody: a note every 96 ticks = one beat = 24000 frames; the 8 notes of the file
    expect(on("pulse1")).toEqual([
      [0, 72],
      [24_000, 74],
      [48_000, 76],
      [72_000, 77],
      [96_000, 79],
      [120_000, 77],
      [144_000, 76],
      [168_000, 74],
    ]);
    // bass: the same rhythm, 36 36 43 41 twice (its notes sit in the triangle range, no transposition)
    expect(on("triangle").map(([, n]) => n)).toEqual([
      36, 36, 43, 41, 36, 36, 43, 41,
    ]);
    // drums: kick (noise note 36) at 0, snare (62) after one beat = 24000 frames, kick after two beats
    expect(on("noise")).toEqual([
      [0, 36],
      [24_000, 62],
      [48_000, 36],
    ]);
    expect(events.events.filter((e) => e.type === "loop")).toHaveLength(0);
  });

  it("takes the id from the file name, refuses to overwrite and overwrites with --force", async () => {
    const { project, repo } = await makeProject();
    writeTune(repo, "Boss Theme (v2).mid");
    const first = await run(repo, ["import", "Boss Theme (v2).mid", "--json"]);
    expect(first.json.path).toBe("songs/boss-theme-v2.json");
    expect(
      fs.existsSync(path.join(project, "songs", "boss-theme-v2.json"))
    ).toBe(true);
    const again = await run(repo, ["import", "Boss Theme (v2).mid", "--json"]);
    expect(again.code).toBe(1);
    expect(again.json.error.message).toContain("already exists");
    const forced = await run(repo, [
      "import",
      "Boss Theme (v2).mid",
      "--force",
      "--json",
    ]);
    expect(forced.code, forced.stderr).toBe(0);
  });

  it("keeps instruments that already exist when a second song is imported for the same chip", async () => {
    const { project, repo } = await makeProject();
    writeTune(repo);
    await run(repo, ["import", "tune.mid", "--json"]);
    const file = path.join(project, "instruments", "midi-nes-lead.json");
    const edited = readJson(file) as { name: string };
    edited.name = "My lead";
    fs.writeFileSync(file, JSON.stringify(edited));
    const second = await run(repo, [
      "import",
      "tune.mid",
      "--id",
      "tune-2",
      "--json",
    ]);
    expect(second.code, second.stderr).toBe(0);
    expect((second.json as Imported).instruments.every((i) => !i.created)).toBe(
      true
    );
    expect((readJson(file) as { name: string }).name).toBe("My lead");
  });

  it("imports for another chip and with a map", async () => {
    const { project, repo } = await makeProject("genesis");
    writeTune(repo);
    const r = await run(repo, [
      "import",
      "tune.mid",
      "--id",
      "mapped",
      "--chip",
      "nes",
      "--map",
      "1=pulse2,3=-",
      "--rows-per-beat",
      "8",
      "--json",
    ]);
    expect(r.code, r.stderr).toBe(0);
    const out = r.json as Imported & { doc: { rowsPerBeat: number } };
    expect(out.chip).toBe("nes");
    expect(out.doc.rowsPerBeat).toBe(8);
    // MIDI channel 1 (the melody) went to pulse2 as told, channel 3 does not exist in the file; the bass and drums stay automatic
    expect(out.parts.map((p) => p.target)).toEqual([
      "pulse2",
      "triangle",
      "noise",
    ]);
    expect(readJson(path.join(project, "songs", "mapped.json"))).toBeTruthy();
    const genesis = await run(repo, [
      "import",
      "tune.mid",
      "--id",
      "gen",
      "--json",
    ]);
    expect(genesis.json.chip).toBe("genesis");
    expect((genesis.json as Imported).parts.map((p) => p.target)).toEqual([
      "fm2",
      "fm1",
      "psgNoise",
    ]);
  });

  it("fails with the documented exit codes", async () => {
    const { repo } = await makeProject();
    const missing = await run(repo, ["import", "nope.mid", "--json"]);
    expect(missing.code).toBe(4);
    expect(missing.json.error.code).toBe("not-found");

    fs.writeFileSync(path.join(repo, "bad.mid"), "this is not midi at all");
    const bad = await run(repo, ["import", "bad.mid", "--json"]);
    expect(bad.code).toBe(1);
    expect(bad.json.error.code).toBe("invalid");
    expect(bad.json.error.message).toContain("MThd");

    writeTune(repo);
    const noFile = await run(repo, ["import", "--json"]);
    expect(noFile.code).toBe(2);
    const badMap = await run(repo, [
      "import",
      "tune.mid",
      "--map",
      "1pulse1",
      "--json",
    ]);
    expect(badMap.code).toBe(2);
    const badTarget = await run(repo, [
      "import",
      "tune.mid",
      "--map",
      "1=fm1",
      "--json",
    ]);
    expect(badTarget.code).toBe(1);
    expect(badTarget.json.error.message).toContain(
      "not a channel of this chip"
    );
    const badChip = await run(repo, [
      "import",
      "tune.mid",
      "--chip",
      "custom",
      "--json",
    ]);
    expect(badChip.code).toBe(2);
    const badRows = await run(repo, [
      "import",
      "tune.mid",
      "--rows-per-beat",
      "0",
      "--json",
    ]);
    expect(badRows.code).toBe(1);
    const badId = await run(repo, [
      "import",
      "tune.mid",
      "--id",
      "Bad Id",
      "--json",
    ]);
    expect(badId.code).toBe(2);
  });

  it("spreads chords over free channels, or arpeggiates them, as --chords says", async () => {
    const { project, repo } = await makeProject();
    fs.writeFileSync(path.join(repo, "chords.mid"), chordTune());
    const spread = await run(repo, [
      "import",
      "chords.mid",
      "--chip",
      "genesis",
      "--json",
    ]);
    const out = spread.json as Imported & { chords: string };
    expect(out.chords).toBe("auto");
    expect(out.issues.map((i) => [i.severity, i.message])).toEqual([
      ["info", "1 chord on t1ch1 spread to fm3 and fm4"],
    ]);
    const song = readJson(path.join(project, "songs", "chords.json")) as {
      patterns: Record<string, { tracks: Record<string, { note: unknown }[]> }>;
    };
    const tracks = Object.values(song.patterns)[0]?.tracks ?? {};
    expect(Object.keys(tracks).sort()).toEqual(["fm2", "fm3", "fm4"]);

    const arp = await run(repo, [
      "import",
      "chords.mid",
      "--chip",
      "nes",
      "--chords",
      "arpeggio",
      "--id",
      "arp",
      "--json",
    ]);
    expect((arp.json as Imported).issues.map((i) => i.message)).toEqual([
      "1 chord on t1ch1 became an arpeggio on pulse1",
    ]);
    const nes = readJson(path.join(project, "songs", "arp.json")) as {
      patterns: Record<
        string,
        { tracks: { pulse1: { fx: unknown[]; note: number }[] } }
      >;
    };
    const first = Object.values(nes.patterns)[0]?.tracks.pulse1[0];
    expect(first?.note).toBe(60);
    expect(first?.fx).toEqual([{ type: "arp", x: 4, y: 7 }]);

    const top = await run(repo, [
      "import",
      "chords.mid",
      "--chords",
      "top",
      "--id",
      "top",
      "--json",
    ]);
    expect(
      (top.json as Imported).issues.map((i) => [i.severity, i.message])
    ).toEqual([
      [
        "warning",
        "pulse1: 2 notes dropped (chords and notes on one row keep only the top note), first at bar 1 beat 1",
      ],
    ]);

    const human = await run(repo, [
      "import",
      "chords.mid",
      "--chip",
      "genesis",
      "--id",
      "human",
    ]);
    expect(human.stdout).toContain("Converted (1):");
    expect(human.stdout).toContain(
      "info /channels/fm2: 1 chord on t1ch1 spread to fm3 and fm4"
    );
    expect(human.stdout).not.toContain("Lost or changed");

    const bad = await run(repo, [
      "import",
      "chords.mid",
      "--chords",
      "stack",
      "--id",
      "bad",
      "--json",
    ]);
    expect(bad.code).toBe(2);
    expect(bad.json.error.message).toContain("--chords must be one of");
  });

  it("is in the help, the workflow page and prints a readable summary", async () => {
    const { repo } = await makeProject();
    const overview = await run(repo, ["help"]);
    expect(overview.stdout).toContain("import");
    const workflow = await run(repo, ["help", "workflow"]);
    expect(workflow.stdout).toContain("bleepkit import");
    const help = await run(repo, ["import", "--help"]);
    expect(help.stdout).toContain("--rows-per-beat");
    expect(help.stdout).toContain("--map");
    expect(help.stdout).toContain("--chords");
    writeTune(repo);
    const human = await run(repo, ["import", "tune.mid"]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain("Imported tune.mid as song/tune");
    expect(human.stdout).toContain("t3ch2: 8 notes -> triangle");
    expect(human.stdout).toContain("Lost or changed");
  });
});
