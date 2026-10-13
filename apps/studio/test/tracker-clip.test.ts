/* The tracker's block logic as plain functions: cut a block out of a pattern, put one back (overwriting, clipped), clear,
   transpose, and the text form that goes to the system clipboard and back. */
import { beforeEach, describe, expect, it } from "vitest";
import type { Pattern, Row } from "../src/lib/contract.ts";
import {
  blockToText,
  clearRect,
  clipRect,
  extractBlock,
  pasteBlock,
  rectBetween,
  textToBlock,
  transposeRect,
} from "../src/lib/tracker-clip.ts";
import {
  clearClipboard,
  freshBlock,
  heldBlock,
  holdBlock,
  resolvePaste,
} from "../src/lib/tracker-clipboard.ts";

const INSTS = ["bass", "lead", "noise-hat", "pad"];
const IDS = ["a", "b", "c"];

const row = (r: number, note: Row["note"], extra: Partial<Row> = {}): Row => ({
  fx: [],
  inst: null,
  note,
  row: r,
  vol: null,
  ...extra,
});
const pattern = (length: number, tracks: Pattern["tracks"]): Pattern => ({
  length,
  tracks,
});
const mapOf = (rows: Row[]) => new Map(rows.map((r) => [r.row, r]));
const rowsOf = (p: Pattern, id: string) =>
  (p.tracks[id] ?? []).map((r) => [r.row, r.note]);

/** Channel a: C-4 on rows 0 and 2, an off on 3. Channel b: a full cell on row 1. */
const sample = (): Pattern =>
  pattern(8, {
    a: [row(0, 60), row(2, 62), row(3, "off")],
    b: [
      row(1, 64, {
        fx: [{ type: "vibrato", x: 4, y: 15 }],
        inst: "lead",
        vol: 15,
      }),
    ],
  });

describe("rectangles", () => {
  it("orders two corners and clips to the pattern", () => {
    expect(rectBetween({ ch: 2, row: 5 }, { ch: 0, row: 1 })).toEqual({
      ch0: 0,
      ch1: 2,
      row0: 1,
      row1: 5,
    });
    expect(clipRect({ ch0: 1, ch1: 9, row0: 6, row1: 20 }, 8, 3)).toEqual({
      ch0: 1,
      ch1: 2,
      row0: 6,
      row1: 7,
    });
    expect(clipRect({ ch0: 5, ch1: 6, row0: 0, row1: 1 }, 8, 3)).toBeNull();
    expect(clipRect({ ch0: 0, ch1: 0, row0: 8, row1: 9 }, 8, 3)).toBeNull();
  });
});

describe("extract and paste", () => {
  it("copies whole cells, empty ones included, out of the row maps", () => {
    const p = sample();
    const block = extractBlock(
      [mapOf(p.tracks.a ?? []), mapOf(p.tracks.b ?? [])],
      { ch0: 0, ch1: 1, row0: 1, row1: 3 }
    );
    expect(block.channels).toBe(2);
    expect(block.rows).toBe(3);
    expect(block.cells[0]?.map((c) => c.note)).toEqual([null, 62, "off"]);
    expect(block.cells[1]?.[0]).toEqual({
      fx: [{ type: "vibrato", x: 4, y: 15 }],
      inst: "lead",
      note: 64,
      vol: 15,
    });
    // a copy, not a view: editing the pattern later does not change the block
    const first = p.tracks.b?.[0];
    if (first) {
      first.fx[0] = { type: "arp", x: 0, y: 0 };
    }
    expect(block.cells[1]?.[0]?.fx[0]?.type).toBe("vibrato");
  });

  it("pastes with the top left at the point, overwriting, and keeps the rows sorted", () => {
    const src = sample();
    const block = extractBlock(
      [mapOf(src.tracks.a ?? []), mapOf(src.tracks.b ?? [])],
      { ch0: 0, ch1: 1, row0: 0, row1: 3 }
    );
    const dst = pattern(8, { a: [row(5, 50), row(6, 51)] });
    const rect = pasteBlock(dst, IDS, block, { ch: 0, row: 4 });
    expect(rect).toEqual({ ch0: 0, ch1: 1, row0: 4, row1: 7 });
    // rows 4..7 of a are the block's rows 0..3 (the old rows 5 and 6 are overwritten, empty cells included)
    expect(rowsOf(dst, "a")).toEqual([
      [4, 60],
      [6, 62],
      [7, "off"],
    ]);
    expect(dst.tracks.b?.map((r) => r.row)).toEqual([5]);
    expect(dst.tracks.b?.[0]?.inst).toBe("lead");
  });

  it("clips to the pattern length and to the song's channels", () => {
    const src = sample();
    const block = extractBlock(
      [mapOf(src.tracks.a ?? []), mapOf(src.tracks.b ?? [])],
      { ch0: 0, ch1: 1, row0: 0, row1: 3 }
    );
    const dst = pattern(4, {});
    // two rows fit below row 2; the second channel does not exist when only one is left
    expect(pasteBlock(dst, IDS, block, { ch: 2, row: 2 })).toEqual({
      ch0: 2,
      ch1: 2,
      row0: 2,
      row1: 3,
    });
    expect(rowsOf(dst, "c")).toEqual([[2, 60]]);
    expect(dst.tracks.a).toBeUndefined();
    expect(pasteBlock(dst, IDS, block, { ch: 0, row: 4 })).toBeNull();
    expect(pasteBlock(dst, ["a"], block, { ch: 1, row: 0 })).toBeNull();
  });

  it("pastes pulse rows into any channel and leaves channels in the locked set alone", () => {
    const src = sample();
    const block = extractBlock([mapOf(src.tracks.a ?? [])], {
      ch0: 0,
      ch1: 0,
      row0: 0,
      row1: 0,
    });
    const dst = pattern(4, { c: [row(0, 40, { inst: "noise-hat" })] });
    pasteBlock(dst, IDS, block, { ch: 2, row: 0 }, new Set(["c"]));
    expect(dst.tracks.c?.[0]?.note).toBe(40);
    pasteBlock(dst, IDS, block, { ch: 2, row: 0 });
    expect(dst.tracks.c?.[0]).toMatchObject({ inst: null, note: 60, row: 0 });
  });

  it("an empty block removes what it covers and drops emptied tracks", () => {
    const dst = pattern(4, { a: [row(1, 60)] });
    const empty = extractBlock([], { ch0: 0, ch1: 0, row0: 0, row1: 3 });
    pasteBlock(dst, IDS, empty, { ch: 0, row: 0 });
    expect(dst.tracks.a).toBeUndefined();
  });
});

describe("clear and transpose", () => {
  it("clears cells in the rectangle only", () => {
    const p = sample();
    clearRect(p, IDS, { ch0: 0, ch1: 1, row0: 2, row1: 7 });
    expect(rowsOf(p, "a")).toEqual([[0, 60]]);
    expect(p.tracks.b?.map((r) => r.row)).toEqual([1]);
    clearRect(p, IDS, { ch0: 0, ch1: 1, row0: 0, row1: 1 });
    expect(p.tracks).toEqual({});
  });

  it("does not touch the channels in the locked set", () => {
    const p = sample();
    clearRect(p, IDS, { ch0: 0, ch1: 1, row0: 0, row1: 7 }, new Set(["a"]));
    expect(rowsOf(p, "a")).toHaveLength(3);
    expect(p.tracks.b).toBeUndefined();
  });

  it("moves note numbers, keeps offs and the rest of the cell, and holds 0..127", () => {
    const p = sample();
    p.tracks.a?.push(row(4, 127), row(5, 0));
    const n = transposeRect(p, IDS, { ch0: 0, ch1: 1, row0: 0, row1: 7 }, 12);
    expect(n).toBe(5);
    expect(rowsOf(p, "a")).toEqual([
      [0, 72],
      [2, 74],
      [3, "off"],
      [4, 127],
      [5, 12],
    ]);
    expect(p.tracks.b?.[0]).toMatchObject({
      inst: "lead",
      note: 76,
      vol: 15,
    });
    transposeRect(p, IDS, { ch0: 0, ch1: 0, row0: 5, row1: 5 }, -24);
    expect(p.tracks.a?.find((r) => r.row === 5)?.note).toBe(0);
  });
});

describe("the text form", () => {
  const block = () =>
    extractBlock(
      (() => {
        const p = sample();
        return [mapOf(p.tracks.a ?? []), mapOf(p.tracks.b ?? [])];
      })(),
      { ch0: 0, ch1: 1, row0: 0, row1: 3 }
    );

  it("writes one line per row, channels separated by ' | ', cells as the grid draws them", () => {
    expect(blockToText(block(), INSTS)).toBe(
      [
        "C-4 -- - --- | --- -- - ---",
        "--- -- - --- | E-4 01 F 44F",
        "D-4 -- - --- | --- -- - ---",
        "=== -- - --- | --- -- - ---",
      ].join("\n")
    );
  });

  it("reads its own text back, instruments by the number in the list", () => {
    const back = textToBlock(blockToText(block(), INSTS), INSTS);
    expect(back).toEqual(block());
    const one = textToBlock("C-4 03 F 4F4", INSTS);
    expect(one?.cells[0]?.[0]).toEqual({
      fx: [{ type: "vibrato", x: 15, y: 4 }],
      inst: "pad",
      note: 60,
      vol: 15,
    });
  });

  it("keeps the notes of the lowest octave and the release mark", () => {
    const p = pattern(2, { a: [row(0, 3), row(1, "release")] });
    const b = extractBlock([mapOf(p.tracks.a ?? [])], {
      ch0: 0,
      ch1: 0,
      row0: 0,
      row1: 1,
    });
    expect(textToBlock(blockToText(b, INSTS), INSTS)).toEqual(b);
  });

  it("writes '??' for an instrument that is not listed and reads it as none", () => {
    const p = pattern(1, { a: [row(0, 60, { inst: "gone" })] });
    const b = extractBlock([mapOf(p.tracks.a ?? [])], {
      ch0: 0,
      ch1: 0,
      row0: 0,
      row1: 0,
    });
    const text = blockToText(b, INSTS);
    expect(text).toBe("C-4 ?? - ---");
    expect(textToBlock(text, INSTS)?.cells[0]?.[0]?.inst).toBeNull();
  });

  it("pads the effect columns of a channel to its widest cell", () => {
    const p = pattern(2, {
      a: [
        row(0, 60, {
          fx: [
            { type: "arp", x: 4, y: 7 },
            { type: "cut", x: 0, y: 3 },
          ],
        }),
        row(1, 62),
      ],
    });
    const b = extractBlock([mapOf(p.tracks.a ?? [])], {
      ch0: 0,
      ch1: 0,
      row0: 0,
      row1: 1,
    });
    expect(blockToText(b, INSTS)).toBe("C-4 -- - 047 S03\nD-4 -- - --- ---");
  });

  it("refuses text that is not in the shape, and ragged lines", () => {
    for (const bad of [
      "",
      "hello world",
      "C-4 03",
      "C-4 03 F zzz",
      "C-4 03 G 000",
      "C-4 -- - --- | D-4 -- - ---\nC-4 -- - ---",
      "H-4 -- - ---",
      "C-4 -- - 047 047 047 047 047",
    ]) {
      expect(textToBlock(bad, INSTS)).toBeNull();
    }
    expect(textToBlock("C-4 -- - ---\r\nD-4 -- - ---\r\n", INSTS)?.rows).toBe(
      2
    );
  });
});

describe("the clipboard", () => {
  beforeEach(clearClipboard);
  const small = () =>
    extractBlock([mapOf([row(0, 60, { inst: "lead" })])], {
      ch0: 0,
      ch1: 0,
      row0: 0,
      row1: 0,
    });

  it("holds the block it was given, and offers it fresh until something else is copied", () => {
    expect(heldBlock()).toBeNull();
    expect(freshBlock()).toBeNull();
    const b = small();
    holdBlock(b, INSTS);
    expect(heldBlock()).toBe(b);
    expect(freshBlock()).toBe(b);
    document.dispatchEvent(new Event("copy"));
    expect(freshBlock()).toBeNull();
    expect(heldBlock()).toBe(b);
  });

  it("pastes the held block when the system text is empty, unreadable or the text it wrote", () => {
    const b = small();
    holdBlock(b, INSTS);
    expect(resolvePaste(null, INSTS)).toBe(b);
    expect(resolvePaste("", INSTS)).toBe(b);
    expect(resolvePaste("C-4 01 - ---\n", INSTS)).toBe(b);
    expect(resolvePaste("some words from a web page", INSTS)).toBe(b);
  });

  it("takes newer text from the system clipboard, and text alone when nothing is held", () => {
    holdBlock(small(), INSTS);
    const other = resolvePaste("G-4 02 8 ---", INSTS);
    expect(other?.cells[0]?.[0]).toMatchObject({ inst: "noise-hat", note: 67 });
    clearClipboard();
    expect(resolvePaste("G-4 02 8 ---", INSTS)?.rows).toBe(1);
    expect(resolvePaste("nothing to see", INSTS)).toBeNull();
    expect(resolvePaste(undefined, INSTS)).toBeNull();
  });

  it("copies without a system clipboard, and when the system clipboard refuses", () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    expect(() => holdBlock(small(), INSTS)).not.toThrow();
    let asked = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (t: string) => {
          asked = t;
          return Promise.reject(new Error("denied"));
        },
      },
    });
    expect(() => holdBlock(small(), INSTS)).not.toThrow();
    expect(asked).toBe("C-4 01 - ---");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => {
          throw new Error("not allowed");
        },
      },
    });
    expect(() => holdBlock(small(), INSTS)).not.toThrow();
    Reflect.deleteProperty(navigator, "clipboard");
  });
});
