import { describe, expect, it } from "vitest";
import { compileSong } from "../src/engine/timeline.ts";
import type { GridTiming, Row, Song } from "../src/index.ts";
import {
  formatRowString,
  mmlToPatterns,
  mmlToRows,
  normalizeSong,
  parseRowString,
  patternToMml,
  songTiming,
} from "../src/index.ts";

/** A song of NES channels: `mml` per channel id, `patterns` and `order` for a mixed one. */
function song(
  mml: Record<string, string | null>,
  extra: Record<string, unknown> = {}
): Song {
  const channels = Object.entries(mml).map(([id, text]) => ({
    id,
    mml: text,
  }));
  const r = normalizeSong({ channels, chip: "nes", ...extra });
  expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
  return r.value;
}

const eights = (n: string) => `${n} ${n} ${n} ${n} ${n} ${n} ${n} ${n}`;

/** The played notes of every channel, with volume and instrument resolved, and no order or row labels. */
function played(s: Song): string[][] {
  const tl = compileSong(s);
  return tl.tracks.map((track, ci) => {
    const inst = s.channels.find(
      (c) => c.id === tl.channels[ci]?.id
    )?.instrument;
    let vol = 15;
    let current = inst ?? null;
    const out: string[] = [];
    for (const e of track) {
      if (e.type === "note" || e.type === "fx") {
        vol = e.vol ?? vol;
        current = e.inst ?? current;
      }
      if (e.type === "note") {
        out.push(`${e.pulse} on ${e.note} v${vol} ${current}`);
      } else if (e.type === "off" && e.pulse < tl.totalPulses) {
        out.push(`${e.pulse} off`);
      }
    }
    return out;
  });
}

/** The timing of a 4 rows per beat song at 60 Hz ticks. */
const timing = (tempo = 120): GridTiming => ({
  rowsPerBeat: 4,
  tempo,
  tickRate: 60,
});

const trackOf = (s: Song, pattern: string, ch: string): Row[] =>
  s.patterns[pattern]?.tracks[ch] ?? [];

/** The rows of a track as compact strings by row: "C-4 lead vF", "... . . G05". */
const rowStrings = (rows: readonly Row[]): string[] =>
  rows.map((r) => `${r.row} ${formatRowString(r)}`);

describe("mmlToPatterns", () => {
  it("turns an MML-only song with sections into named, shared patterns", () => {
    const mml = [
      "l8 t120",
      "; section: Verse",
      eights("c"),
      "; section: Chorus",
      eights("e"),
      "; section: Verse",
      eights("c"),
    ].join("\n");
    const before = song({ pulse1: mml }, { loop: null });
    const { song: after, issues } = mmlToPatterns(before);
    expect(issues).toEqual([]);
    expect(after.channels.every((c) => c.mml === null)).toBe(true);
    expect(after.order).toEqual(["Verse", "Chorus", "Verse"]);
    expect(Object.keys(after.patterns)).toEqual(["Verse", "Chorus"]);
    expect(Object.values(after.patterns).some((p) => p.generated)).toBe(false);
    expect(trackOf(after, "Verse", "pulse1")).toHaveLength(8);
    expect(trackOf(after, "Chorus", "pulse1")[0]?.note).toBe(64);
    expect(played(after)).toEqual(played(before));
    expect(compileSong(after).totalPulses).toBe(
      compileSong(before).totalPulses
    );
  });

  it("expands repeats into a pattern the order plays again", () => {
    const before = song({ pulse1: `[${eights("c")}]3` }, { loop: null });
    const { song: after } = mmlToPatterns(before);
    expect(after.order).toEqual(["A", "A", "A"]);
    expect(Object.keys(after.patterns)).toEqual(["A"]);
    expect(played(after)).toEqual(played(before));
  });

  it("puts the loop on an order boundary, splitting a pattern when it falls inside one", () => {
    const mml = `l8 ${eights("c")} c c L c c ${eights("d")}`;
    const before = song({ pulse1: mml });
    const { song: after } = mmlToPatterns(before);
    const tl = compileSong(after);
    expect(tl.loopPulse).toBe(compileSong(before).loopPulse);
    expect(tl.orderStarts[after.loop ?? 0]).toBe(tl.loopPulse);
    expect(played(after)).toEqual(played(before));
  });

  it("keeps a triplet between rows with a delay (Gxx) and the song's own rows per beat", () => {
    // quarter note triplets: 64 pulses each, the grid has a row every 24 (120 BPM, 60 Hz ticks: 3.2 pulses each)
    const before = song({ pulse1: "l6 c d e" }, { loop: null });
    const { song: after, issues } = mmlToPatterns(before);
    expect(issues).toEqual([]);
    expect(after.rowsPerBeat).toBe(4);
    expect(after.channels[0]?.mml).toBeNull();
    const rows = trackOf(after, "A", "pulse1");
    // pulse 64 is 5 ticks into row 2, pulse 128 is 3 ticks into row 5
    expect(rows.find((r) => r.row === 0)?.fx).toEqual([]);
    expect(rows.find((r) => r.row === 2)?.note).toBe(62);
    expect(rows.find((r) => r.row === 2)?.fx).toEqual([
      { type: "delay", x: 0, y: 5 },
    ]);
    expect(rows.find((r) => r.row === 5)?.note).toBe(64);
    expect(rows.find((r) => r.row === 5)?.fx).toEqual([
      { type: "delay", x: 0, y: 3 },
    ]);
    expect(compileSong(after).totalPulses).toBe(
      compileSong(before).totalPulses
    );
  });

  it("leaves a delay that rounds to nothing off, and moves a note that rounds to the next row", () => {
    // at 200 BPM a tick is 5.3 pulses: 2 pulses after the row is 0.4 of a tick
    const [none] = mmlToRows("r192 c4", timing(200), {}).rows;
    expect(none?.row).toBe(0);
    expect(none?.fx).toEqual([]);
    // at 100 BPM a row is 9 ticks and 23 pulses is 8.6 of them: the next row
    const [next] = mmlToRows("r32 r48 r128 c4", timing(100), {}).rows;
    expect(next?.row).toBe(1);
    expect(next?.fx).toEqual([]);
  });

  it("cuts a gated note with a cut (Sxx) on the row where it ends", () => {
    // q7: each eighth note (48 pulses) sounds 42 of them, which is 18 pulses (6 ticks) into the second row
    const before = song({ pulse1: "q7 l8 c d e f" }, { loop: null });
    const { song: after, issues } = mmlToPatterns(before);
    expect(issues).toEqual([]);
    expect(after.channels[0]?.mml).toBeNull();
    expect(rowStrings(trackOf(after, "A", "pulse1"))).toEqual([
      "0 C-4",
      "1 ... . . S06",
      "2 D-4",
      "3 ... . . S06",
      "4 E-4",
      "5 ... . . S06",
      "6 F-4",
      "7 ... . . S06",
    ]);
  });

  it("writes a plain note off when the end of a gated note falls on a row", () => {
    const { rows } = mmlToRows("l2 q7 c", timing(), {});
    // 7/8 of 192 pulses is 168: row 7 starts at 168
    expect(rowStrings(rows)).toEqual(["0 C-4", "7 OFF"]);
    const gate = mmlToRows("l2 q6 c", timing(), {}).rows;
    // 144 pulses = row 6, on the grid
    expect(rowStrings(gate)).toEqual(["0 C-4", "6 OFF"]);
    const between = mmlToRows("l2 q5 c", timing(), {}).rows;
    // 120 pulses = row 5 exactly; q5 of 192 is 120
    expect(rowStrings(between)).toEqual(["0 C-4", "5 OFF"]);
  });

  it("cuts the note that lasts to the end of a looping song on the last row, so the loop seam is clean", () => {
    const looping = song({ pulse1: "l8 c d e f" });
    const once = song({ pulse1: "l8 c d e f" }, { loop: null });
    const lastRow = (s: Song) =>
      formatRowString(
        trackOf(mmlToPatterns(s).song, "A", "pulse1").at(-1) as Row
      );
    // 8 rows of 7.5 ticks: the cut is on the last tick before the song ends
    expect(
      trackOf(mmlToPatterns(looping).song, "A", "pulse1").at(-1)?.row
    ).toBe(7);
    expect(lastRow(looping)).toBe("... . . S07");
    expect(lastRow(once)).toBe("F-4");
  });

  it("keeps a channel as MML only when the patterns jump, skip or halt", () => {
    const base = normalizeSong({
      channels: [
        { id: "pulse1", mml: "l8 c d e f" },
        { id: "pulse2", mml: null },
      ],
      chip: "nes",
      order: ["a"],
      patterns: {
        a: {
          length: 8,
          tracks: { pulse2: [{ fx: ["B00"], note: "C-4", row: 0 }] },
        },
      },
    });
    expect(base.ok).toBe(true);
    const r = mmlToPatterns(base.value);
    expect(r.song).toBe(base.value);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.path).toBe("/channels/0/mml");
    expect(r.issues[0]?.message).toContain("jump");
  });

  it("gives back the same rows when a track goes to text and back, delays and cuts included", () => {
    const rows: Row[] = [
      "C-4 lead",
      "...",
      "E-4 . . S03",
      "...",
      "F-4",
      "... . . S02",
      "...",
      "...",
      "G-4 . . G02",
      "...",
      "OFF",
      "...",
      "A-4 . . G03",
    ].flatMap((text, row) =>
      text === "..." ? [] : [parseRowString(text, row).row]
    );
    for (const tempo of [60, 90, 100, 120, 150, 200]) {
      const t = timing(tempo);
      const text = patternToMml(rows, 4, 16, t);
      const back = mmlToRows(text, t, {}).rows.filter((r) => r.row < 16);
      expect(rowStrings(back)).toEqual(rowStrings(rows));
    }
  });

  it("gives back a converted channel from its text, row for row", () => {
    const before = song(
      { pulse1: "l6 q6 c d e f g a l8 q7 b >c d e", pulse2: "t100 l8 c d e f" },
      { loop: null }
    );
    const { song: after } = mmlToPatterns(before);
    const t = songTiming(after);
    let start = 0;
    for (const id of after.order) {
      const pattern = after.patterns[id];
      const rows = pattern?.tracks.pulse1 ?? [];
      const text = patternToMml(rows, after.rowsPerBeat, pattern?.length, {
        ...t,
        startRow: start,
      });
      const back = mmlToRows(text, t, { startRow: start }).rows.filter(
        (r) => r.row < (pattern?.length ?? 0)
      );
      expect(rowStrings(back)).toEqual(rowStrings(rows));
      start += pattern?.length ?? 0;
    }
  });

  it("clones a pattern that several order slots play when the MML differs between them", () => {
    const base = normalizeSong({
      channels: [
        { id: "pulse1", mml: `l8 ${eights("c")} ${eights("g")}` },
        { id: "pulse2", mml: null },
      ],
      chip: "nes",
      order: ["verse", "verse", "bridge"],
      patterns: {
        bridge: { length: 16, tracks: { pulse2: [{ note: "C-5", row: 0 }] } },
        verse: { length: 16, tracks: { pulse2: [{ note: "C-4", row: 0 }] } },
      },
    });
    expect(base.ok).toBe(true);
    const { song: after, issues } = mmlToPatterns(base.value);
    expect(issues).toEqual([]);
    expect(after.channels[0]?.mml).toBeNull();
    expect(after.order).toEqual(["verse", "verse 2", "bridge"]);
    expect(trackOf(after, "verse", "pulse1")[0]?.note).toBe(60);
    expect(trackOf(after, "verse 2", "pulse1")[0]?.note).toBe(67);
    // the other channel's rows are untouched, and the original pattern is not overwritten
    expect(trackOf(after, "verse 2", "pulse2")).toEqual(
      trackOf(after, "verse", "pulse2")
    );
    expect(played(after)).toEqual(played(base.value));
  });

  it("shares a pattern between slots whose MML slices agree", () => {
    const base = normalizeSong({
      channels: [{ id: "pulse1", mml: `l8 ${eights("c")} ${eights("c")}` }],
      chip: "nes",
      loop: null,
      order: ["a", "a"],
      patterns: { a: { length: 16, tracks: {} } },
    });
    const { song: after } = mmlToPatterns(base.value);
    expect(after.order).toEqual(["a", "a"]);
    expect(Object.keys(after.patterns)).toEqual(["a"]);
  });

  it("leaves a song without MML alone", () => {
    const plain = song({ pulse1: null });
    const r = mmlToPatterns(plain);
    expect(r.song).toBe(plain);
    expect(r.issues).toEqual([]);
  });
});
