import { describe, expect, it } from "vitest";
import { compileSong } from "../src/engine/timeline.ts";
import type { Row, Song } from "../src/index.ts";
import { mmlToPatterns, normalizeSong } from "../src/index.ts";

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

const trackOf = (s: Song, pattern: string, ch: string): Row[] =>
  s.patterns[pattern]?.tracks[ch] ?? [];

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
    const before = song({ pulse1: mml });
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
    const before = song({ pulse1: `[${eights("c")}]3` });
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

  it("uses more rows per beat for triplets, and keeps the song's length", () => {
    const before = song({ pulse1: "l8 c c c l12 c c c c c c" });
    const { song: after, issues } = mmlToPatterns(before);
    expect(issues).toEqual([]);
    expect(after.rowsPerBeat).toBe(12);
    expect(played(after)).toEqual(played(before));
  });

  it("keeps a channel as MML when its timing is between rows, and says why", () => {
    const before = song({ pulse1: "l8 c d e f", pulse2: "q7 l12 c d e f" });
    const { song: after, issues } = mmlToPatterns(before);
    expect(after.channels.map((c) => c.mml !== null)).toEqual([false, true]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("/channels/1/mml");
    expect(issues[0]?.message).toContain("pulse2");
    expect(issues[0]?.message).toContain("grid");
    const odd = song({ pulse1: "q7 l12 c d e f" });
    const none = mmlToPatterns(odd);
    expect(none.song).toBe(odd);
    expect(none.issues).toHaveLength(1);
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
