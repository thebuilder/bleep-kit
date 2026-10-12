/* ProTracker MOD reading, import and export (architecture.md section 2.10), from a module built byte by byte. */

import { describe, expect, it } from "vitest";
import {
  AMIGA_CLOCK_HZ,
  base64ToBytes,
  modToSong,
  parseMod,
  renderSong,
  songToMod,
} from "../src/index.ts";
import { analyze } from "../src/tools.ts";

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

interface TestCell {
  channel: number;
  effect?: number;
  param?: number;
  period?: number;
  row: number;
  sample?: number;
}

interface TestMod {
  cells: TestCell[][];
  loop?: boolean;
  order: number[];
  restart?: number;
  tag?: string;
}

/** Sample 1: a 64 byte square with a loop over its second half; sample 2: a 32 byte ramp without a loop. */
function build(mod: TestMod): Uint8Array {
  const patterns = mod.cells.length;
  const channels =
    ({ "6CHN": 6, "8CHN": 8 } as Record<string, number>)[mod.tag ?? ""] ?? 4;
  const sampleData = [
    Int8Array.from({ length: 64 }, (_, i) => (i < 32 ? 100 : -100)),
    Int8Array.from({ length: 32 }, (_, i) => i * 4 - 64),
  ];
  const size = 1084 + patterns * 64 * channels * 4 + 96;
  const b = new Uint8Array(size);
  b.set(ascii("hand built"), 0);
  const head = (
    n: number,
    name: string,
    words: number,
    ft: number,
    vol: number,
    ls: number,
    ll: number
  ) => {
    const o = 20 + n * 30;
    b.set(ascii(name), o);
    b[o + 22] = words >> 8;
    b[o + 23] = words & 255;
    b[o + 24] = ft;
    b[o + 25] = vol;
    b[o + 26] = ls >> 8;
    b[o + 27] = ls & 255;
    b[o + 28] = ll >> 8;
    b[o + 29] = ll & 255;
  };
  head(0, "square", 32, 0, 48, 16, 16);
  head(1, "ramp", 16, 2, 64, 0, 1);
  for (let i = 31 - 1; i >= 2; i -= 1) {
    head(i, "", 0, 0, 0, 0, 1);
  }
  b[950] = mod.order.length;
  b[951] = mod.restart ?? 127;
  mod.order.forEach((p, i) => {
    b[952 + i] = p;
  });
  b.set(ascii(mod.tag ?? "M.K."), 1080);
  mod.cells.forEach((cells, p) => {
    for (const c of cells) {
      const o = 1084 + (p * 64 * channels + c.row * channels + c.channel) * 4;
      const period = c.period ?? 0;
      const sample = c.sample ?? 0;
      b[o] = (sample & 0xf0) | (period >> 8);
      b[o + 1] = period & 255;
      b[o + 2] = ((sample & 15) << 4) | (c.effect ?? 0);
      b[o + 3] = c.param ?? 0;
    }
  });
  let at = 1084 + patterns * 64 * channels * 4;
  for (const d of sampleData) {
    for (let i = 0; i < d.length; i += 1) {
      b[at + i] = (d[i] ?? 0) & 255;
    }
    at += d.length;
  }
  return b;
}

const SIMPLE: TestMod = {
  cells: [
    [
      { channel: 0, period: 428, row: 0, sample: 1 },
      { channel: 1, period: 214, row: 0, sample: 2 },
      { channel: 0, effect: 12, param: 24, period: 320, row: 4, sample: 0 },
      { channel: 2, period: 508, row: 8, sample: 1 },
      { channel: 3, effect: 13, param: 0x16, row: 15 },
    ],
    [{ channel: 0, period: 226, row: 0, sample: 1 }],
  ],
  order: [0, 1, 0],
  restart: 1,
};

describe("parseMod", () => {
  it("reads the header, the samples, the order list and the cells", () => {
    const { file, issues } = parseMod(build(SIMPLE));
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(file?.title).toBe("hand built");
    expect(file?.channels).toBe(4);
    expect(file?.order).toEqual([0, 1, 0]);
    expect(file?.restart).toBe(1);
    const s1 = file?.samples[0];
    expect(s1).toMatchObject({
      loopLength: 32,
      loopStart: 32,
      name: "square",
      volume: 48,
    });
    expect(s1?.data.length).toBe(64);
    expect(file?.samples[1]?.finetune).toBe(2);
    expect(file?.samples[1]?.loopLength).toBe(2);
    expect(file?.patterns[0]?.[0]?.[0]).toEqual({
      effect: 0,
      param: 0,
      period: 428,
      sample: 1,
    });
    expect(file?.patterns[0]?.[15]?.[3]).toMatchObject({
      effect: 13,
      param: 0x16,
    });
  });

  it("reads sample numbers above 15 from the high nibble", () => {
    const bytes = build({
      cells: [[{ channel: 0, period: 428, row: 0, sample: 17 }]],
      order: [0],
    });
    expect(parseMod(bytes).file?.patterns[0]?.[0]?.[0]?.sample).toBe(17);
  });

  it("says what is wrong with files that are not modules", () => {
    expect(parseMod(new Uint8Array(100)).issues[0]?.message).toContain(
      "too small"
    );
    const bad = build(SIMPLE);
    bad.set(ascii("XXXX"), 1080);
    const parsed = parseMod(bad);
    expect(parsed.file).toBeNull();
    expect(parsed.issues[0]?.message).toContain("no ProTracker tag");
  });

  it("warns about a file cut off inside the sample data and still reads it", () => {
    const bytes = build(SIMPLE).slice(0, 1084 + 2 * 1024 + 20);
    const { file, issues } = parseMod(bytes);
    expect(file?.samples[0]?.data.length).toBe(20);
    expect(issues.some((i) => i.message.includes("cut off"))).toBe(true);
  });
});

describe("modToSong", () => {
  const imp = modToSong(build(SIMPLE), { id: "hand" });
  const { instruments, samples, song } = imp;

  it("builds an amiga song with a sample, an instrument and a loop per used sample", () => {
    expect(song.chip).toBe("amiga");
    expect(song.tickRate).toBe(50);
    expect(song.rowsPerBeat).toBe(4);
    expect(song.tempo).toBe(125);
    expect(Object.keys(samples)).toEqual(["hand-01-square", "hand-02-ramp"]);
    expect(instruments["hand-01-square"]?.sample?.userSample).toBe(
      "hand-01-square"
    );
    const sq = samples["hand-01-square"];
    expect(sq).toMatchObject({
      baseNote: 36,
      bits: 8,
      loop: { end: 64, start: 32 },
      rate: 8287,
      volume: 0.75,
    });
    expect(base64ToBytes(sq?.data ?? "").length).toBe(64);
    expect(samples["hand-02-ramp"]?.finetune).toBe(25);
    expect(samples["hand-02-ramp"]?.loop).toBeNull();
  });

  it("maps periods to notes, the volume to the column and keeps the restart position", () => {
    const first = song.patterns[song.order[0] ?? ""];
    const ch1 = first?.tracks.ch1 ?? [];
    expect(ch1[0]).toMatchObject({
      inst: "hand-01-square",
      note: 36,
      row: 0,
      vol: 15,
    });
    // C24 sets 24 of the sample's own 48: the column is round(24 * 15 / 48) = 8 of 15.
    expect(ch1[1]?.note).toBe(41);
    expect(ch1[1]?.vol).toBe(8);
    expect(first?.tracks.ch2?.[0]?.note).toBe(48);
    expect(song.loop).toBe(1);
    expect(song.order).toHaveLength(3);
    expect(song.order[0]).toBe(song.order[2]);
  });

  it("cuts a pattern at a pattern break and writes the skip", () => {
    const first = song.patterns[song.order[0] ?? ""];
    expect(first?.length).toBe(16);
    const skip = first?.tracks.ch4?.find((r) => r.row === 15)?.fx[0];
    // D16 is decimal: row 16.
    expect(skip).toMatchObject({ type: "skip", x: 1, y: 0 });
  });

  it("renders to audible, unclipped audio", () => {
    const r = renderSong(song, instruments, { sampleRate: 22_050, samples });
    const a = analyze(r);
    expect(a.peakDb).toBeGreaterThan(-30);
    expect(a.clipped.frames).toBe(0);
  });

  it("uses the custom chip for 8 channels and says so", () => {
    const eight = modToSong(
      build({
        cells: [[{ channel: 5, period: 428, row: 0, sample: 1 }]],
        order: [0],
        tag: "8CHN",
      })
    );
    expect(eight.song.chip).toBe("custom");
    expect(eight.song.channels).toHaveLength(8);
    expect(eight.issues.some((i) => i.message.includes("custom chip"))).toBe(
      true
    );
    expect(Object.values(eight.song.patterns)[0]?.tracks.ch6?.[0]?.note).toBe(
      36
    );
  });

  it("reports the effects it cannot map", () => {
    const odd = modToSong(
      build({
        cells: [
          [
            {
              channel: 0,
              effect: 14,
              param: 0xe2,
              period: 428,
              row: 0,
              sample: 1,
            },
            { channel: 1, effect: 8, param: 0x40, row: 1 },
          ],
        ],
        order: [0],
      })
    );
    const msg =
      odd.issues.find((i) => i.message.startsWith("not converted"))?.message ??
      "";
    expect(msg).toContain("pattern delay");
    expect(msg).toContain("8xx");
  });

  it("converts speed and tempo changes so the song keeps its length", () => {
    const fast = modToSong(
      build({
        cells: [
          [
            {
              channel: 0,
              effect: 15,
              param: 3,
              period: 428,
              row: 0,
              sample: 1,
            },
          ],
        ],
        order: [0],
      })
    );
    const tempo = Object.values(
      fast.song.patterns
    )[0]?.tracks.ch1?.[0]?.fx.find((e) => e.type === "tempo");
    // speed 3 at 125 BPM runs twice as fast as speed 6: 250 Bleepkit BPM at 4 rows per beat.
    expect((tempo?.x ?? 0) * 16 + (tempo?.y ?? 0)).toBe(250);
  });
});

describe("songToMod", () => {
  it("writes a module that reads back with the same notes, samples and loops", () => {
    const imp = modToSong(build(SIMPLE), { id: "hand" });
    const out = songToMod(imp.song, imp.instruments, imp.samples);
    expect(out.bytes).not.toBeNull();
    expect(out.issues.filter((i) => i.severity === "error")).toEqual([]);
    const back = parseMod(out.bytes ?? new Uint8Array(0)).file;
    expect(back?.samples[0]).toMatchObject({
      loopLength: 32,
      loopStart: 32,
      volume: 48,
    });
    expect(back?.samples[0]?.data.length).toBe(64);
    expect(Array.from(back?.samples[0]?.data ?? [])).toEqual(
      Array.from(parseMod(build(SIMPLE)).file?.samples[0]?.data ?? [])
    );
    expect(back?.samples[1]?.finetune).toBe(2);
    expect(back?.order.length).toBe(3);
    const cell = back?.patterns[back.order[0] ?? 0]?.[0]?.[0];
    expect(cell).toMatchObject({ period: 428, sample: 1 });
    const again = modToSong(out.bytes ?? new Uint8Array(0), { id: "hand" });
    const ch1 =
      again.song.patterns[again.song.order[0] ?? ""]?.tracks.ch1 ?? [];
    expect(ch1.map((r) => r.note).filter((n) => n !== null)).toEqual([36, 41]);
  });

  it("refuses songs of other chips with a message", () => {
    const imp = modToSong(build(SIMPLE));
    const nes = { ...imp.song, chip: "nes" as const };
    const out = songToMod(nes, imp.instruments, imp.samples);
    expect(out.bytes).toBeNull();
    expect(out.issues[0]?.message).toContain("only amiga songs");
  });

  it("splits patterns longer than 64 rows and keeps the clock constant in the log", () => {
    const imp = modToSong(build(SIMPLE));
    const long = JSON.parse(JSON.stringify(imp.song)) as typeof imp.song;
    const pid = long.order[0] ?? "";
    const pat = long.patterns[pid];
    if (pat) {
      pat.length = 100;
    }
    const out = songToMod(long, imp.instruments, imp.samples);
    const back = parseMod(out.bytes ?? new Uint8Array(0)).file;
    expect(back?.songLength).toBe(5);
    expect(AMIGA_CLOCK_HZ).toBe(3_546_895);
  });
});
