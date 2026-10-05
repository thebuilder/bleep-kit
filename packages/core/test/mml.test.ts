import { describe, expect, it } from "vitest";
import type { MmlEvent } from "../src/index.ts";
import { formatMml, mmlToTrack, parseMml, patternToMml } from "../src/index.ts";
import { mmlPanToByte } from "../src/mml/index.ts";

type NoteEvent = Extract<MmlEvent, { type: "note" }>;

function notes(src: string): NoteEvent[] {
  return parseMml(src).events.filter((e): e is NoteEvent => e.type === "note");
}

function errors(src: string): string[] {
  return parseMml(src)
    .issues.filter((i) => i.severity === "error")
    .map((i) => i.message);
}

function warnings(src: string): string[] {
  return parseMml(src)
    .issues.filter((i) => i.severity === "warning")
    .map((i) => i.message);
}

describe("mml grammar", () => {
  it("notes map to MIDI numbers with the octave command", () => {
    expect(notes("o4 c d e f g a b").map((n) => n.note)).toEqual([
      60, 62, 64, 65, 67, 69, 71,
    ]);
    expect(notes("o5 c").map((n) => n.note)).toEqual([72]);
    expect(notes("o0 c").map((n) => n.note)).toEqual([12]);
  });

  it("accidentals: plus and sharp raise, minus lowers", () => {
    expect(notes("c+ c# d-").map((n) => n.note)).toEqual([61, 61, 61]);
    expect(notes("f+ g-").map((n) => n.note)).toEqual([66, 66]);
  });

  it("octave up and down commands change the octave and clamp at the ends", () => {
    expect(notes("c > c < < c").map((n) => n.note)).toEqual([60, 72, 48]);
    expect(notes("o8 > c").map((n) => n.note)).toEqual([108]);
    expect(notes("o0 < c").map((n) => n.note)).toEqual([12]);
  });

  it("n<midi> plays a note by number with an optional length", () => {
    const ev = notes("n60 n72 4");
    expect(ev.map((n) => n.note)).toEqual([60, 72]);
    expect(ev[1]?.duration).toBe(96);
  });

  it("lengths: 384/n pulses, default length l8 is 48 pulses", () => {
    const ev = notes("c c4 c16 c1 c2");
    expect(ev.map((n) => n.duration)).toEqual([48, 96, 24, 384, 192]);
  });

  it("dots multiply by 1.5, 1.75 and 1.875", () => {
    const ev = notes("c4. c4.. c4...");
    expect(ev.map((n) => n.duration)).toEqual([144, 168, 180]);
  });

  it("l sets the default length and accepts dots", () => {
    const ev = notes("l16 c c l4. c");
    expect(ev.map((n) => n.duration)).toEqual([24, 24, 144]);
  });

  it("rests advance time and emit rest events", () => {
    const p = parseMml("c r4 c");
    const rest = p.events.find((e) => e.type === "rest");
    expect(rest).toMatchObject({ duration: 96, pulse: 48 });
    expect(notes("c r4 c")[1]?.pulse).toBe(144);
    expect(p.endPulse).toBe(192);
  });

  it("v sets the volume of following notes and emits a volume event", () => {
    const p = parseMml("v8 c v3 d");
    expect(notes("v8 c v3 d").map((n) => n.volume)).toEqual([8, 3]);
    expect(p.events.filter((e) => e.type === "volume")).toHaveLength(2);
    expect(notes("c")[0]?.volume).toBe(15);
  });

  it("p sets the pan and emits a pan event", () => {
    const p = parseMml("p0 c p15 d");
    expect(
      p.events
        .filter((e) => e.type === "pan")
        .map((e) => (e.type === "pan" ? e.value : -1))
    ).toEqual([0, 15]);
    expect(mmlPanToByte(8)).toBe(128);
    expect(mmlPanToByte(0)).toBe(0);
    expect(mmlPanToByte(15)).toBe(255);
  });

  it("@id selects an instrument by letters, digits and dashes", () => {
    const p = parseMml("@lead-2 c @drums d");
    expect(notes("@lead-2 c @drums d").map((n) => n.inst)).toEqual([
      "lead-2",
      "drums",
    ]);
    expect(p.events.filter((e) => e.type === "inst")).toHaveLength(2);
    expect(notes("c")[0]?.inst).toBeNull();
  });

  it("q sets the gate as a fraction of the length", () => {
    const ev = notes("q4 c4 q8 c4 q1 c4");
    expect(ev.map((n) => n.gate)).toEqual([48, 96, 12]);
  });

  it("k transposes by signed semitones", () => {
    expect(notes("k-12 c").map((n) => n.note)).toEqual([48]);
    expect(notes("k+7 c k0 c").map((n) => n.note)).toEqual([67, 60]);
  });

  it("t sets the tempo, only the first one counts", () => {
    expect(parseMml("t140 c").tempo).toBe(140);
    const p = parseMml("t140 c t90 c");
    expect(p.tempo).toBe(140);
    expect(p.issues.some((i) => i.severity === "warning")).toBe(true);
    expect(parseMml("c").tempo).toBeNull();
  });

  it("w attaches a duty effect to the next note", () => {
    const n = notes("w2 c d");
    expect(n[0]?.fx).toHaveLength(1);
    expect(n[0]?.fx[0]).toMatchObject({ type: "duty" });
    expect(n[1]?.fx).toHaveLength(0);
  });

  it("braces attach tracker effects to the next note only", () => {
    const n = notes("{A0F}{047} c d");
    expect(n[0]?.fx.map((f) => f.type)).toEqual(["volSlide", "arp"]);
    expect(n[1]?.fx).toEqual([]);
    const spaced = notes("{A0F 047} c");
    expect(spaced[0]?.fx).toHaveLength(2);
  });

  it("ties join same-pitch notes without a retrigger", () => {
    const ev = notes("c4&c8");
    expect(ev).toHaveLength(1);
    expect(ev[0]?.duration).toBe(96 + 48);
    expect(notes("c&c&c").map((n) => n.duration)).toEqual([144]);
  });

  it("a tie between different pitches warns and plays both", () => {
    const p = parseMml("c4&d4");
    expect(p.events.filter((e) => e.type === "note")).toHaveLength(2);
    expect(p.issues.some((i) => i.severity === "warning")).toBe(true);
  });

  it("repeats expand, default twice, and nest", () => {
    expect(notes("[c d]").map((n) => n.note)).toEqual([60, 62, 60, 62]);
    expect(notes("[c]3").map((n) => n.note)).toEqual([60, 60, 60]);
    expect(notes("[[c d]2 e]2")).toHaveLength(10);
    expect(notes("[c]1")).toHaveLength(1);
  });

  it("repeats nest at most 4 deep", () => {
    expect(errors("[[[[[c]2]2]2]2]2").some((m) => m.includes("nest"))).toBe(
      true
    );
    expect(errors("[[[[c]2]2]2]2")).toEqual([]);
  });

  it("L marks the loop point and the first one wins", () => {
    const p = parseMml("c d L e f");
    expect(p.loopPulse).toBe(96);
    expect(p.events.filter((e) => e.type === "loop")).toHaveLength(1);
    const again = parseMml("c L d L e");
    expect(again.loopPulse).toBe(48);
    expect(again.issues.some((i) => i.severity === "warning")).toBe(true);
  });

  it("bar lines, whitespace and comments are ignored", () => {
    expect(notes("c | d ; e f\n g").map((n) => n.note)).toEqual([60, 62, 67]);
  });

  it("empty and comment-only sources parse to nothing", () => {
    expect(parseMml("").events).toEqual([]);
    expect(parseMml("; nothing here").events).toEqual([]);
    expect(parseMml("   ").endPulse).toBe(0);
  });

  it("options set the default octave, length and volume", () => {
    const n = parseMml("c", { length: 4, octave: 3, volume: 9 })
      .events[0] as NoteEvent;
    expect(n.note).toBe(48);
    expect(n.duration).toBe(96);
    expect(n.volume).toBe(9);
  });

  it("out of range notes clamp with a warning", () => {
    expect(notes("n200").map((n) => n.note)).toEqual([127]);
    expect(warnings("n200").length).toBeGreaterThan(0);
    expect(notes("k-48 o0 c").map((n) => n.note)).toEqual([0]);
  });
});

describe("mml errors", () => {
  it("never throws on junk", () => {
    for (const src of [
      "]",
      "[",
      "[c",
      "c]",
      "&",
      "c&",
      "{",
      "{}",
      "@",
      "o",
      "n",
      "k",
      "z",
      "123",
      "c99",
      "...",
      "c4.....",
      "%$!",
    ]) {
      expect(() => parseMml(src)).not.toThrow();
    }
  });

  it("unknown commands report the character offset", () => {
    const e = errors("c d z e");
    expect(e).toHaveLength(1);
    expect(e[0]).toContain("offset 4");
  });

  it("errors name the offset of the offending token", () => {
    expect(errors("cde ]")[0]).toContain("offset 4");
    expect(errors("c [d e")[0]).toContain("offset 2");
    expect(errors("c d c99")[0]).toContain("offset");
  });

  it("an unsupported length is an error", () => {
    expect(errors("c5").some((m) => m.includes("length"))).toBe(true);
    expect(errors("c4").length).toBe(0);
  });

  it("a command with a missing number is an error, out of range numbers clamp with a warning", () => {
    expect(errors("o c").some((m) => m.includes('"o"'))).toBe(true);
    expect(errors("v c").some((m) => m.includes('"v"'))).toBe(true);
    expect(warnings("v99 c").some((m) => m.includes("clamped"))).toBe(true);
    expect(notes("v99 c")[0]?.volume).toBe(15);
    expect(notes("o99 c")[0]?.note).toBe(108);
    expect(notes("q0 c4")[0]?.gate).toBe(12);
  });

  it("bad effect codes are errors", () => {
    expect(errors("{zz} c").length).toBeGreaterThan(0);
    expect(errors("{} c").length).toBeGreaterThan(0);
  });

  it("a fifth effect on one note is dropped with a warning", () => {
    const p = parseMml("{A01}{A02}{A03}{A04}{A05} c");
    expect(notes("{A01}{A02}{A03}{A04}{A05} c")[0]?.fx).toHaveLength(4);
    expect(p.issues.some((i) => i.severity === "warning")).toBe(true);
  });

  it("an unclosed repeat is an error and the rest still parses", () => {
    const e = errors("[c d");
    expect(e.some((m) => m.includes("unclosed"))).toBe(true);
  });

  it("issue paths use /mml", () => {
    for (const i of parseMml("z").issues) {
      expect(i.path).toBe("/mml");
    }
  });
});

describe("mml formatting", () => {
  const sources = [
    "o4 l8 c d e f g a b > c",
    "c4. d8. e16.. f4...",
    "v12 @lead c4 v5 @bass d4 p3 e4",
    "q4 c4 q8 d4 q2 e8",
    "[c d e]3 L f g",
    "o2 c1 o6 c2 o4 r4 r1",
    "{A0F}{047} c4 d4",
    "c4&c8 d2&d8 r8",
    "n12 4 n100 8 n60",
    "k-5 c k3 d",
    "c1&c1&c4",
    "c192 c128 c96 r64",
  ];

  for (const src of sources) {
    it(`format then reparse keeps the events: ${src}`, () => {
      const a = parseMml(src);
      expect(a.issues.filter((i) => i.severity === "error")).toEqual([]);
      const text = formatMml(a.events);
      const b = parseMml(text);
      expect(b.issues.filter((i) => i.severity === "error")).toEqual([]);
      expect(b.events).toEqual(a.events);
    });
  }

  it("formatting is idempotent", () => {
    for (const src of sources) {
      const once = formatMml(parseMml(src).events);
      const twice = formatMml(parseMml(once).events);
      expect(twice).toBe(once);
    }
  });

  it("lengths that need several tokens round trip as ties", () => {
    const a = parseMml("c1&c4&c16");
    const b = parseMml(formatMml(a.events));
    expect(b.events).toEqual(a.events);
  });
});

describe("mmlToTrack", () => {
  it("places notes on rows with a note off after a gap", () => {
    const { rows, issues } = mmlToTrack("@lead c4 r4 d4", 4);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    const byRow = new Map(rows.map((r) => [r.row, r]));
    expect(byRow.get(0)).toMatchObject({ inst: "lead", note: 60 });
    expect(byRow.get(4)?.note).toBe("off");
    expect(byRow.get(8)?.note).toBe(62);
  });

  it("finer than a row notes are rounded with a warning", () => {
    const { issues } = mmlToTrack("c32 c32 c32", 4);
    expect(issues.some((i) => i.severity === "warning")).toBe(true);
  });

  it("returns the loop row", () => {
    const { loopRow } = mmlToTrack("c4 c4 L c4", 4);
    expect(loopRow).toBe(8);
    expect(mmlToTrack("c4", 4).loopRow).toBeNull();
  });

  it("patternToMml reparses to the same notes", () => {
    const rows = [
      { fx: [], inst: "lead", note: 60, row: 0, vol: 15 },
      { fx: [], inst: null, note: 64, row: 4, vol: null },
      { fx: [], inst: null, note: "off" as const, row: 8, vol: null },
      { fx: [], inst: null, note: 67, row: 12, vol: 9 },
    ];
    const text = patternToMml(rows, 4);
    const back = notes(text);
    expect(back.map((n) => n.note)).toEqual([60, 64, 67]);
    expect(back.map((n) => n.pulse)).toEqual([0, 96, 288]);
    expect(back[2]?.volume).toBe(9);
  });
});
