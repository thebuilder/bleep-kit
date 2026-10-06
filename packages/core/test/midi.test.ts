/* MIDI import (architecture.md section 2.8). Every file here is built byte by byte, and the expectations are worked out
   by hand from the bytes: a note at tick 192 of a 96 ppq file at 4 rows per beat is row 8. */

import { describe, expect, it } from "vitest";
import type { MidiImport, NoteValue, Row, Song } from "../src/index.ts";
import {
  CHIP_IDS,
  midiToSong,
  normalizeSong,
  parseMidi,
  parseMidiMap,
  renderSong,
} from "../src/index.ts";
import { arpeggioOf, type ChordHost, placeChords } from "../src/midi/chords.ts";
import type { Chord } from "../src/midi/reduce.ts";

/* ---------- building files ---------- */

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  let rest = Math.floor(n / 128);
  while (rest > 0) {
    out.unshift((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  return out;
}

/** One event: delta ticks, then the raw bytes. */
function ev(delta: number, ...data: number[]): number[] {
  return [...vlq(delta), ...data];
}

function tempoEv(delta: number, bpm: number): number[] {
  const us = Math.round(60_000_000 / bpm);
  return ev(
    delta,
    0xff,
    0x51,
    3,
    (us >> 16) & 0xff,
    (us >> 8) & 0xff,
    us & 0xff
  );
}

function timeSigEv(
  delta: number,
  numerator: number,
  denominator: number
): number[] {
  return ev(delta, 0xff, 0x58, 4, numerator, Math.log2(denominator), 24, 8);
}

function nameEv(text: string): number[] {
  return ev(
    0,
    0xff,
    0x03,
    text.length,
    ...[...text].map((c) => c.charCodeAt(0))
  );
}

const END = ev(0, 0xff, 0x2f, 0);

function u32(n: number): number[] {
  return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function chunk(id: string, data: number[]): number[] {
  return [...[...id].map((c) => c.charCodeAt(0)), ...u32(data.length), ...data];
}

function track(...events: number[][]): number[] {
  return chunk("MTrk", [...events.flat(), ...END]);
}

function smf(format: number, ppq: number, ...tracks: number[][]): Uint8Array {
  const head = chunk("MThd", [
    0,
    format,
    0,
    tracks.length,
    ppq >> 8,
    ppq & 0xff,
  ]);
  return Uint8Array.from([...head, ...tracks.flat()]);
}

const ON = 0x90;
const DRUM_ON = 0x99;

/** A note on and its note off `length` ticks later, on a channel; deltas are from the previous event of the track. */
function noteAt(
  gap: number,
  channel: number,
  note: number,
  velocity: number,
  length: number
): number[][] {
  return [
    ev(gap, ON | channel, note, velocity),
    ev(length, 0x80 | channel, note, 0),
  ];
}

/** A melody: one note every `step` ticks, each lasting `length` ticks. */
function line(
  channel: number,
  notes: number[],
  step: number,
  length: number,
  velocity = 100
): number[][] {
  return notes.flatMap((note, i) =>
    noteAt(i === 0 ? 0 : step - length, channel, note, velocity, length)
  );
}

/* ---------- reading a song back ---------- */

interface Placed extends Row {
  abs: number;
}

/** Rows of a channel across the whole order, with absolute row numbers. */
function rowsOf(song: Song, channel: string): Placed[] {
  const out: Placed[] = [];
  let base = 0;
  for (const id of song.order) {
    const pat = song.patterns[id];
    for (const r of pat?.tracks[channel] ?? []) {
      out.push({ ...r, abs: base + r.row });
    }
    base += pat?.length ?? 0;
  }
  return out;
}

function notesOn(song: Song, channel: string): [number, NoteValue | null][] {
  return rowsOf(song, channel)
    .filter((r) => r.note !== null)
    .map((r) => [r.abs, r.note]);
}

function errors(r: MidiImport): string[] {
  return r.issues.filter((i) => i.severity === "error").map((i) => i.message);
}

function warnings(r: MidiImport): string[] {
  return r.issues.map((i) => i.message);
}

function expectValid(r: MidiImport): void {
  expect(errors(r)).toEqual([]);
  const again = normalizeSong(r.song, r.instruments);
  expect(again.issues.filter((i) => i.severity === "error")).toEqual([]);
}

/* ---------- the parser ---------- */

describe("parseMidi", () => {
  it("reads a format 0 file with running status and velocity 0 as note off", () => {
    // 90 3C 64 | (running) 3E 64 after 96 | then note ons with velocity 0 closing each note
    const file = smf(
      0,
      96,
      track(
        tempoEv(0, 120),
        ev(0, 0x90, 60, 100),
        ev(96, 62, 100), // running status: another note on at tick 96
        ev(96, 60, 0), // running status, velocity 0: note off for 60 at tick 192
        ev(96, 62, 0) // note off for 62 at tick 288
      )
    );
    const midi = parseMidi(file);
    expect(midi.issues).toEqual([]);
    expect(midi.format).toBe(0);
    expect(midi.ppq).toBe(96);
    expect(midi.notes).toEqual([
      { channel: 0, end: 192, note: 60, start: 0, track: 0, velocity: 100 },
      { channel: 0, end: 288, note: 62, start: 96, track: 0, velocity: 100 },
    ]);
    expect(midi.tempos).toEqual([{ bpm: 120, tick: 0 }]);
    expect(midi.endTick).toBe(288);
  });

  it("reads tempo and time signature metas, track names and several tracks", () => {
    const file = smf(
      1,
      480,
      track(timeSigEv(0, 3, 4), tempoEv(0, 140), tempoEv(1920, 90)),
      track(nameEv("Melody"), ...noteAt(480, 2, 64, 90, 240))
    );
    const midi = parseMidi(file);
    expect(midi.format).toBe(1);
    expect(midi.timeSignatures).toEqual([
      { denominator: 4, numerator: 3, tick: 0 },
    ]);
    expect(midi.tempos.map((t) => [t.tick, Math.round(t.bpm)])).toEqual([
      [0, 140],
      [1920, 90],
    ]);
    expect(
      midi.tracks.map((t) => [t.index, t.name, t.channels, t.noteCount])
    ).toEqual([
      [0, null, [], 0],
      [1, "Melody", [2], 1],
    ]);
    expect(midi.notes).toEqual([
      { channel: 2, end: 720, note: 64, start: 480, track: 1, velocity: 90 },
    ]);
  });

  it("defaults to 120 BPM when the file sets no tempo, and ends a hanging note with its track", () => {
    const midi = parseMidi(
      smf(0, 96, track(ev(0, ON, 60, 100), ev(200, 0xb0, 7, 100)))
    );
    expect(midi.tempos).toEqual([{ bpm: 120, tick: 0 }]);
    expect(midi.notes).toEqual([
      { channel: 0, end: 200, note: 60, start: 0, track: 0, velocity: 100 },
    ]);
    expect(midi.issues.map((i) => i.message).join("\n")).toContain(
      "never released"
    );
  });

  it("restarts a note that is struck again while held", () => {
    const midi = parseMidi(
      smf(
        0,
        96,
        track(ev(0, ON, 60, 100), ev(48, ON, 60, 80), ev(48, ON, 60, 0))
      )
    );
    expect(midi.notes.map((n) => [n.start, n.end, n.velocity])).toEqual([
      [0, 48, 100],
      [48, 96, 80],
    ]);
  });

  it("skips sysex, unknown chunks and program changes", () => {
    const file = Uint8Array.from([
      ...smf(
        0,
        96,
        track(
          ev(0, 0xf0, 3, 1, 2, 0xf7),
          ev(0, 0xc0, 5),
          ev(0, ON, 60, 100),
          ev(96, ON, 60, 0)
        )
      ),
      ...chunk("XFIH", [1, 2, 3]),
    ]);
    const midi = parseMidi(file);
    expect(midi.issues).toEqual([]);
    expect(midi.notes).toHaveLength(1);
  });

  it("never throws: garbage, an empty buffer and a cut-off track come back as issues", () => {
    expect(parseMidi(new Uint8Array(0)).issues[0]?.severity).toBe("error");
    expect(
      parseMidi(
        Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
      ).issues[0]?.message
    ).toContain("MThd");
    const whole = smf(
      0,
      96,
      track(...noteAt(0, 0, 60, 100, 96), ...noteAt(0, 0, 62, 100, 96))
    );
    const cut = whole.slice(0, whole.length - 9);
    const midi = parseMidi(cut);
    expect(midi.notes[0]).toMatchObject({ end: 96, note: 60, start: 0 });
    expect(midi.issues.map((i) => i.severity)).not.toContain("error");
    expect(midi.issues.map((i) => i.message).join("\n")).toContain("cut short");
  });

  it("reads SMPTE division as a fixed 120 BPM with a warning", () => {
    // 25 fps, 40 subframes: 1000 ticks per second, 500 per quarter at 120 BPM
    const head = chunk("MThd", [0, 0, 0, 1, 0xe7, 40]);
    const midi = parseMidi(
      Uint8Array.from([...head, ...track(...noteAt(0, 0, 60, 100, 500))])
    );
    expect(midi.ppq).toBe(500);
    expect(midi.issues.map((i) => i.message).join("\n")).toContain("SMPTE");
  });
});

/* ---------- rows from ticks ---------- */

describe("midiToSong: notes become rows", () => {
  it("puts known notes at known rows with the velocity in the volume column", () => {
    // 96 ppq, 4 rows per beat: a row is 24 ticks. Notes at ticks 0, 96, 240 last 48, 24, 48 ticks.
    const file = smf(
      0,
      96,
      track(
        tempoEv(0, 100),
        ...noteAt(0, 0, 72, 127, 48),
        ...noteAt(48, 0, 74, 64, 24),
        ...noteAt(120, 0, 76, 1, 48)
      )
    );
    const r = midiToSong(file);
    expectValid(r);
    expect(r.song.tempo).toBe(100);
    expect(r.song.rowsPerBeat).toBe(4);
    expect(r.song.chip).toBe("nes");
    expect(notesOn(r.song, "pulse1")).toEqual([
      [0, 72],
      [2, "off"],
      [4, 74],
      [5, "off"],
      [10, 76],
      // the last note would end at row 12, the end of the song: its off moves to the last row, 11, so it cannot leak
      // into the start of the loop
      [11, "off"],
    ]);
    const rows = rowsOf(r.song, "pulse1");
    expect(rows.filter((x) => x.note !== "off").map((x) => x.vol)).toEqual([
      15, 8, 1,
    ]);
    expect(r.song.channels.find((c) => c.id === "pulse1")?.instrument).toBe(
      "midi-nes-lead"
    );
    expect(Object.keys(r.instruments)).toEqual(["midi-nes-lead"]);
    expect(r.instruments["midi-nes-lead"]?.kind).toBe("pulse");
  });

  it("rounds other resolutions to the nearest row, and honors rowsPerBeat", () => {
    // 480 ppq: tick 130 is row 1.08 -> 1, tick 300 is row 2.5 -> 3 (rounds up), tick 480 is row 4.
    const file = smf(
      0,
      480,
      track(
        ...noteAt(130, 0, 60, 100, 60),
        ...noteAt(110, 0, 62, 100, 60),
        ...noteAt(110, 0, 64, 100, 60)
      )
    );
    const four = midiToSong(file);
    expect(notesOn(four.song, "pulse1").filter(([, n]) => n !== "off")).toEqual(
      [
        [1, 60],
        [3, 62],
        [4, 64],
      ]
    );
    // 8 rows per beat: a row is 60 ticks; the same notes sit at 130/60=2.17 -> 2, 300/60=5, 480/60=8
    const eight = midiToSong(file, { rowsPerBeat: 8 });
    expect(eight.song.rowsPerBeat).toBe(8);
    expect(
      notesOn(eight.song, "pulse1").filter(([, n]) => n !== "off")
    ).toEqual([
      [2, 60],
      [5, 62],
      [8, 64],
    ]);
  });

  it("keeps a legato note going when the next one starts on the row its note off would sit on", () => {
    // (the file runs on 96 ticks after the last note, so the final note off has a row to sit on)
    const file = smf(
      0,
      96,
      track(
        ...noteAt(0, 0, 60, 100, 24),
        ...noteAt(0, 0, 62, 100, 24),
        ev(96, 0xb0, 7, 1)
      )
    );
    const r = midiToSong(file);
    expect(notesOn(r.song, "pulse1")).toEqual([
      [0, 60],
      [1, 62],
      [2, "off"],
    ]);
  });

  it("cuts the pattern grid to whole bars and lengthens the song to the end of the last bar", () => {
    // 4/4 at 4 rows per beat: a bar is 16 rows, a pattern 4 bars (64 rows). One note in bar 5 (tick 1536 = row 64).
    // the file ends 300 ticks after the note: past row 68, before the end of bar 5 (tick 1920)
    const file = smf(
      0,
      96,
      track(...noteAt(1536, 0, 60, 100, 96), ev(300, 0xb0, 7, 1))
    );
    const r = midiToSong(file);
    expectValid(r);
    expect(r.song.order).toHaveLength(2);
    expect(r.song.patterns[r.song.order[0] ?? ""]?.length).toBe(64);
    // the note ends at row 68; the last pattern runs on to the end of its bar (row 80)
    expect(r.song.patterns[r.song.order[1] ?? ""]?.length).toBe(16);
    expect(notesOn(r.song, "pulse1")).toEqual([
      [64, 60],
      [68, "off"],
    ]);
  });

  it("reuses identical patterns and loops to the start unless asked not to", () => {
    const bar = (n: number) => [
      ...noteAt(n === 0 ? 0 : 1536 - 96, 0, 60, 100, 96),
    ];
    // the same riff at ticks 0, 1536, 3072 (every 4 bars): the first two patterns are equal and are stored once;
    // the third is cut short at the end of the song
    const file = smf(0, 96, track(...bar(0), ...bar(1), ...bar(2)));
    const r = midiToSong(file);
    expect(r.song.order).toHaveLength(3);
    expect(r.song.order[1]).toBe(r.song.order[0]);
    expect(r.song.order[2]).not.toBe(r.song.order[0]);
    expect(Object.keys(r.song.patterns)).toHaveLength(2);
    expect(r.song.loop).toBe(0);
    expect(midiToSong(file, { loop: false }).song.loop).toBeNull();
  });
});

/* ---------- parts and mapping ---------- */

/** A tune: melody (channel 0, high, busy), bass (channel 1, low), a pad (channel 2, sparse), drums (channel 10). */
function tune(): Uint8Array {
  const melody = line(0, [72, 74, 76, 77, 79, 77, 76, 74], 48, 36);
  const bass = line(1, [36, 36, 43, 41, 36, 36, 43, 41], 48, 40);
  const pad = line(2, [60, 64], 192, 180, 70);
  const drums = [
    ev(0, DRUM_ON, 36, 120),
    ev(0, DRUM_ON, 42, 80), // hat on the same tick as the kick
    ev(24, DRUM_ON, 42, 80),
    ev(24, DRUM_ON, 38, 110),
    ev(48, DRUM_ON, 36, 120),
  ];
  return smf(
    1,
    96,
    track(tempoEv(0, 120), timeSigEv(0, 4, 4)),
    track(nameEv("Melody"), ...melody),
    track(nameEv("Bass"), ...bass),
    track(nameEv("Pad"), ...pad),
    track(nameEv("Drums"), ...drums)
  );
}

describe("midiToSong: automatic mapping", () => {
  it("sends drums to noise, the low busy part to the triangle, the busy high part to pulse1 and the rest to pulse2", () => {
    const r = midiToSong(tune());
    expectValid(r);
    const target = Object.fromEntries(r.parts.map((p) => [p.name, p.target]));
    expect(target).toEqual({
      Bass: "triangle",
      Drums: "noise",
      Melody: "pulse1",
      Pad: "pulse2",
    });
    expect(notesOn(r.song, "pulse1").find(([, n]) => n !== "off")).toEqual([
      0, 72,
    ]);
    expect(
      notesOn(r.song, "triangle")
        .filter(([, n]) => n !== "off")
        .map(([row]) => row)
    ).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    expect(notesOn(r.song, "pulse2").filter(([, n]) => n !== "off")).toEqual([
      [0, 60],
      [8, 64],
    ]);
    const ch = Object.fromEntries(
      r.song.channels.map((c) => [c.id, c.instrument])
    );
    expect(ch).toEqual({
      noise: "midi-nes-drums",
      pulse1: "midi-nes-lead",
      pulse2: "midi-nes-harmony",
      triangle: "midi-nes-bass",
    });
    expect(Object.keys(r.instruments).sort()).toEqual([
      "midi-nes-bass",
      "midi-nes-drums",
      "midi-nes-harmony",
      "midi-nes-lead",
    ]);
  });

  it("plays drum hits as noise pitches (kick low, snare mid, hat high) and keeps the more important drum on one row", () => {
    const r = midiToSong(tune());
    // ticks 0 (kick+hat), 24 (hat), 48 (snare), 96 (kick): rows 0, 1, 2, 4
    expect(notesOn(r.song, "noise")).toEqual([
      [0, 36],
      [1, 84],
      [2, 62],
      [4, 36],
    ]);
    const drops = r.issues.filter((i) => i.path === "/channels/noise");
    expect(drops).toHaveLength(1);
    expect(drops[0]?.message).toContain("1 drum hits dropped");
    expect(drops[0]?.message).toContain("bar 1 beat 1");
  });

  it("does not write a volume on the triangle (a quiet value would switch it off)", () => {
    const r = midiToSong(tune());
    expect(rowsOf(r.song, "triangle").every((x) => x.vol === null)).toBe(true);
    expect(rowsOf(r.song, "pulse1").find((x) => x.note === 72)?.vol).toBe(12);
  });

  it("lists parts that do not fit on any channel", () => {
    const extra = [1, 2, 3, 4, 5].map((c) =>
      track(...line(c + 3, [60, 62, 64, 65, 67], 48, 40))
    );
    const file = smf(
      1,
      96,
      track(tempoEv(0, 120)),
      track(...line(0, [72, 74, 76, 77, 79], 48, 40)),
      ...extra
    );
    const r = midiToSong(file);
    expect(r.parts.filter((p) => p.target === null).length).toBeGreaterThan(0);
    expect(warnings(r).some((m) => m.includes("was left out on nes"))).toBe(
      true
    );
    expectValid(r);
  });
});

describe("midiToSong: an explicit map", () => {
  it("sends the named parts where they are told, and places the rest on what is left", () => {
    const r = midiToSong(tune(), { map: { "1": "pulse2", "10": "noise" } });
    expectValid(r);
    const target = Object.fromEntries(r.parts.map((p) => [p.name, p.target]));
    // channel 1 (the melody) is forced to pulse2; the bass is still the lowest busy part
    expect(target.Melody).toBe("pulse2");
    expect(target.Bass).toBe("triangle");
    expect(target.Pad).toBe("pulse1");
  });

  it("selects tracks (t3) and track channels (t3ch2), and leaves a part out with -", () => {
    const r = midiToSong(tune(), {
      map: { "3": "-", t2ch1: "pulse2", t3: "pulse1" },
    });
    const target = Object.fromEntries(r.parts.map((p) => [p.name, p.target]));
    expect(target.Bass).toBe("pulse1"); // track 3 is the bass track
    expect(target.Melody).toBe("pulse2");
    expect(target.Pad).toBeNull(); // the "3=-" entry: MIDI channel 3 carries the pad
    expect(notesOn(r.song, "pulse1").find(([, n]) => n !== "off")).toEqual([
      0, 36,
    ]);
  });

  it("merges two parts onto one channel and reports the notes it cannot play at once", () => {
    const r = midiToSong(tune(), {
      chords: "top",
      map: { "1": "pulse1", "3": "pulse1" },
    });
    // pad notes 60 and 64 at rows 0 and 8 start with melody notes 72 and 79 on those rows: the top note stays
    expect(
      notesOn(r.song, "pulse1")
        .filter(([row]) => row === 0 || row === 8)
        .map(([, n]) => n)
    ).toEqual([72, 79]);
    expect(
      r.issues.some(
        (i) =>
          i.path === "/channels/pulse1" && i.message.includes("2 notes dropped")
      )
    ).toBe(true);
  });

  it("rejects bad maps with an error issue", () => {
    expect(
      errors(midiToSong(tune(), { map: { "17": "pulse1" } }))[0]
    ).toContain("map key");
    expect(errors(midiToSong(tune(), { map: { "1": "fm1" } }))[0]).toContain(
      "not a channel of this chip"
    );
    expect(midiToSong(tune(), { map: { "1": "fm1" } }).parts).toEqual([]);
    const loose = midiToSong(tune(), { map: { "5": "pulse1" } });
    expect(errors(loose)).toEqual([]);
    expect(warnings(loose).some((m) => m.includes("matches no part"))).toBe(
      true
    );
  });

  it("parses the text form of a map", () => {
    expect(parseMidiMap("1=pulse1, 2=triangle,10=noise")).toEqual({
      issues: [],
      map: { "1": "pulse1", "2": "triangle", "10": "noise" },
    });
    expect(parseMidiMap("1pulse1").issues[0]?.severity).toBe("error");
  });
});

/* ---------- reducing polyphony and fitting the range ---------- */

describe("midiToSong: one note at a time", () => {
  it("keeps the top note of a chord on the lead and reports the ones it dropped", () => {
    // C major chords (60 64 67) on rows 0 and 4, then a single note
    const chord = (gap: number) => [
      ev(gap, ON, 60, 100),
      ev(0, ON, 64, 100),
      ev(0, ON, 67, 100),
      ev(96, ON, 60, 0),
      ev(0, ON, 64, 0),
      ev(0, ON, 67, 0),
    ];
    const r = midiToSong(
      smf(0, 96, track(...chord(0), ...chord(0), ...noteAt(0, 0, 72, 100, 96))),
      { chords: "top" }
    );
    expect(notesOn(r.song, "pulse1").filter(([, n]) => n !== "off")).toEqual([
      [0, 67],
      [4, 67],
      [8, 72],
    ]);
    const issue = r.issues.find((i) => i.path === "/channels/pulse1");
    expect(issue?.message).toBe(
      "pulse1: 4 notes dropped (chords and notes on one row keep only the top note), first at bar 1 beat 1"
    );
    expect(issue?.severity).toBe("warning");
  });

  it("keeps the bass note of a chord on the bass channel", () => {
    const bassChord = [
      ev(0, ON | 1, 36, 100),
      ev(0, ON | 1, 43, 100),
      ev(96, ON | 1, 36, 0),
      ev(0, ON | 1, 43, 0),
    ];
    const file = smf(
      1,
      96,
      track(tempoEv(0, 120)),
      track(...line(0, [72, 74, 76, 77, 79, 77], 96, 60)),
      track(...bassChord, ...line(1, [36, 38, 40, 41, 43], 96, 60))
    );
    const r = midiToSong(file, { chords: "top" });
    expect(notesOn(r.song, "triangle")[0]).toEqual([0, 36]);
    expect(
      r.issues.find((i) => i.path === "/channels/triangle")?.message
    ).toContain("keep only the lowest note");
  });

  it("lets a later note take over from a held one and counts it as cut short", () => {
    // 60 is held for 4 beats; 62 starts after 1 beat and ends after 2, and the held note does not come back
    const file = smf(
      0,
      96,
      track(
        ev(0, ON, 60, 100),
        ev(96, ON, 62, 100),
        ev(96, ON, 62, 0),
        ev(192, ON, 60, 0)
      )
    );
    const r = midiToSong(file);
    expect(notesOn(r.song, "pulse1")).toEqual([
      [0, 60],
      [4, 62],
      [8, "off"],
    ]);
    expect(
      r.issues.find((i) => i.path === "/channels/pulse1")?.message
    ).toContain("1 note was cut short");
  });

  it("transposes a whole part by octaves into the channel range, and reports it", () => {
    // 24 26 28 29 (C1 D1 E1 F1) are under the NES pulse floor (A1 = 33): the part moves up one octave as a whole
    const r = midiToSong(
      smf(0, 96, track(...line(0, [24, 26, 28, 29], 96, 48)))
    );
    expect(
      notesOn(r.song, "pulse1")
        .filter(([, n]) => n !== "off")
        .map(([, n]) => n)
    ).toEqual([36, 38, 40, 41]);
    expect(warnings(r).some((m) => m.includes("transposed up 1 octave"))).toBe(
      true
    );
  });

  it("folds a stray note into the range after the part is placed", () => {
    // a lead mostly in range with one note above the NES top (108): the part stays put and the stray comes down
    const r = midiToSong(
      smf(0, 96, track(...line(0, [72, 74, 120, 76, 77, 79], 96, 48)))
    );
    expect(
      notesOn(r.song, "pulse1")
        .filter(([, n]) => n !== "off")
        .map(([, n]) => n)
    ).toEqual([72, 74, 108, 76, 77, 79]);
    expect(warnings(r).some((m) => m.includes("1 note moved by octaves"))).toBe(
      true
    );
  });
});

/* ---------- tempo ---------- */

describe("midiToSong: tempo", () => {
  it("takes the first tempo as the song tempo and writes later changes as tempo effects on their rows", () => {
    // 120 BPM, then 150 BPM at tick 384 (bar 2): row 16, F96 (150 = 0x96); row 0 restores 120 = 0x78 for the loop
    const file = smf(
      0,
      96,
      track(tempoEv(0, 120), tempoEv(384, 150)),
      track(...line(0, [72, 74, 76, 77, 79, 77, 76, 74], 96, 48))
    );
    const r = midiToSong(file);
    expectValid(r);
    expect(r.song.tempo).toBe(120);
    const fx = rowsOf(r.song, "pulse1")
      .filter((x) => x.fx.some((f) => f.type === "tempo"))
      .map((x) => [x.abs, x.fx.map((f) => f.x * 16 + f.y)]);
    expect(fx).toEqual([
      [0, [120]],
      [16, [150]],
    ]);
  });

  it("limits tempos outside what a tempo effect holds", () => {
    const file = smf(
      0,
      96,
      track(tempoEv(0, 120), tempoEv(96, 300)),
      track(...line(0, [60, 62, 64, 65], 96, 48))
    );
    const r = midiToSong(file);
    expect(warnings(r).some((m) => m.includes("outside 32 to 255 BPM"))).toBe(
      true
    );
    expectValid(r);
  });
});

/* ---------- chips ---------- */

describe("midiToSong: other chips", () => {
  it("imports for genesis: FM bass and lead, PSG noise drums", () => {
    const r = midiToSong(tune(), { chip: "genesis" });
    expectValid(r);
    const target = Object.fromEntries(r.parts.map((p) => [p.name, p.target]));
    expect(target).toEqual({
      Bass: "fm1",
      Drums: "psgNoise",
      Melody: "fm2",
      Pad: "fm3",
    });
    expect(r.instruments["midi-genesis-lead"]?.kind).toBe("fm");
    expect(r.instruments["midi-genesis-drums"]?.kind).toBe("noise");
    expect(notesOn(r.song, "psgNoise")[0]).toEqual([0, 36]);
  });

  it("plays drums on a SID voice with the noise waveform, and uses that voice for melody when there are no drums", () => {
    const withDrums = midiToSong(tune(), { chip: "c64" });
    expectValid(withDrums);
    expect(withDrums.instruments["midi-c64-drums"]?.sid?.waveforms).toEqual([
      "noise",
    ]);
    const noDrums = midiToSong(
      smf(
        1,
        96,
        track(tempoEv(0, 120)),
        track(...line(0, [72, 74, 76, 77], 48, 36)),
        track(...line(1, [36, 38, 40, 41], 48, 36)),
        track(...line(2, [60, 62, 64, 65], 48, 36))
      )
    );
    expect(noDrums.parts).toHaveLength(3);
    const c64 = midiToSong(
      smf(
        1,
        96,
        track(tempoEv(0, 120)),
        track(...line(0, [72, 74, 76, 77], 48, 36)),
        track(...line(1, [36, 38, 40, 41], 48, 36)),
        track(...line(2, [60, 62, 64, 65], 48, 36))
      ),
      { chip: "c64" }
    );
    expectValid(c64);
    expect(c64.parts.every((p) => p.target !== null)).toBe(true);
    expect(c64.instruments["midi-c64-drums"]).toBeUndefined();
  });

  it("gives each drum its own sample instrument on the sample chip", () => {
    const r = midiToSong(tune(), { chip: "snes" });
    expectValid(r);
    expect(
      Object.keys(r.instruments)
        .filter((id) => id.startsWith("midi-snes-"))
        .sort()
    ).toEqual(
      [
        "midi-snes-bass",
        "midi-snes-hat",
        "midi-snes-kick",
        "midi-snes-lead",
        "midi-snes-harmony",
        "midi-snes-snare",
      ].sort()
    );
    const drums = rowsOf(r.song, "ch8");
    expect(drums.map((x) => x.inst)).toEqual([
      "midi-snes-kick",
      "midi-snes-hat",
      "midi-snes-snare",
      "midi-snes-kick",
    ]);
    expect(r.instruments["midi-snes-snare"]?.sample?.generator).toBe("snare");
  });

  it("gives every importable chip a valid song, and refuses the custom chip", () => {
    for (const chip of CHIP_IDS.filter((c) => c !== "custom")) {
      const r = midiToSong(tune(), { chip });
      expectValid(r);
      expect(r.song.chip).toBe(chip);
      // the SID has three voices: with the drums, bass and lead placed, the pad has nowhere to go
      expect(r.parts.filter((p) => p.target === null)).toHaveLength(
        chip === "c64" ? 1 : 0
      );
    }
    expect(errors(midiToSong(tune(), { chip: "custom" }))[0]).toContain(
      "cannot be imported into"
    );
  });
});

describe("midiToSong: bad input", () => {
  it("returns an error and a default song for something that is not MIDI", () => {
    const r = midiToSong(Uint8Array.from([1, 2, 3]));
    expect(errors(r)[0]).toContain("MThd");
    expect(r.song.chip).toBe("nes");
    expect(r.instruments).toEqual({});
  });

  it("rejects a row grid the song format cannot hold", () => {
    expect(errors(midiToSong(tune(), { rowsPerBeat: 0 }))[0]).toContain(
      "rowsPerBeat"
    );
    expect(errors(midiToSong(tune(), { rowsPerBeat: 2.5 }))[0]).toContain(
      "rowsPerBeat"
    );
  });

  it("warns about a file with no notes", () => {
    const r = midiToSong(smf(0, 96, track(tempoEv(0, 120))));
    expect(r.issues.map((i) => i.message)).toContain("the file has no notes");
  });

  it("suggests a finer grid when many notes miss the rows", () => {
    // notes at 16 ticks past each row of a 24 tick grid: two thirds of a row off
    const file = smf(
      0,
      96,
      track(
        ...line(0, [60, 62, 64, 65, 67, 69, 71, 72], 96, 48).map((e, i) =>
          i === 0 ? ev(16, ...e.slice(1)) : e
        )
      )
    );
    const r = midiToSong(file);
    expect(warnings(r).some((m) => m.includes("off the grid"))).toBe(true);
  });
});

/* ---------- chords: spread first, arpeggio second ---------- */

/** Events given by absolute tick, written as delta times (events on one tick keep their order). */
function trackAbs(...events: [tick: number, bytes: number[]][]): number[][] {
  const sorted = events
    .map((e, i) => ({ bytes: e[1], i, tick: e[0] }))
    .sort((a, b) => a.tick - b.tick || a.i - b.i);
  let last = 0;
  return sorted.map((e) => {
    const out = ev(e.tick - last, ...e.bytes);
    last = e.tick;
    return out;
  });
}

/**
 * Every channel of a small chip is busy when the chord sounds: a lead whose first beat is `chord` (96 ticks, so it ends
 * on row 4 where a melody note follows at once), a pad that holds one note for six beats, a bass and a kick drum.
 * 96 ppq, 4 rows per beat.
 */
function arrangement(chord: number[]): Uint8Array {
  const lead = trackAbs(
    ...chord.map((n): [number, number[]] => [0, [ON, n, 100]]),
    ...chord.map((n): [number, number[]] => [96, [ON, n, 0]]),
    ...[72, 74, 76, 77].flatMap((n, i): [number, number[]][] => [
      [96 + i * 48, [ON, n, 100]],
      [96 + i * 48 + 48, [ON, n, 0]],
    ])
  );
  const pad = trackAbs([0, [ON | 1, 55, 70]], [576, [ON | 1, 55, 0]]);
  const bass = trackAbs(
    ...[0, 1, 2, 3, 4, 5].flatMap((i): [number, number[]][] => [
      [i * 96, [ON | 2, 36, 100]],
      [i * 96 + 60, [ON | 2, 36, 0]],
    ])
  );
  const drums = trackAbs(
    ...[0, 1, 2, 3].flatMap((i): [number, number[]][] => [
      [i * 96, [DRUM_ON, 36, 110]],
      [i * 96 + 12, [DRUM_ON, 36, 0]],
    ])
  );
  return smf(
    1,
    96,
    track(tempoEv(0, 120)),
    track(nameEv("Lead"), ...lead),
    track(nameEv("Pad"), ...pad),
    track(nameEv("Bass"), ...bass),
    track(nameEv("Drums"), ...drums)
  );
}

function fxAt(song: Song, channel: string, row: number): string[] {
  const found = rowsOf(song, channel).find((r) => r.abs === row);
  return (found?.fx ?? []).map((f) => `${f.type}:${f.x},${f.y}`);
}

function infos(r: MidiImport): string[] {
  return r.issues.filter((i) => i.severity === "info").map((i) => i.message);
}

function dropped(r: MidiImport): string[] {
  return r.issues
    .filter((i) => i.severity === "warning" && i.message.includes("dropped"))
    .map((i) => i.message);
}

describe("midiToSong: chords become arpeggios", () => {
  it("turns a C major triad on the NES lead into C with 047, and ends it on the next note", () => {
    // pulse2 (the pad), the triangle (bass) and the noise channel are all busy, so nothing is free to spread to
    const r = midiToSong(arrangement([60, 64, 67]), { chip: "nes" });
    expectValid(r);
    const lead = notesOn(r.song, "pulse1");
    expect(lead[0]).toEqual([0, 60]);
    // C-4, then +4 (E) and +7 (G)
    expect(fxAt(r.song, "pulse1", 0)).toEqual(["arp:4,7"]);
    // the next note starts on row 4, where the chord ends: it stops the arpeggio with 000
    expect(lead[1]).toEqual([4, 72]);
    expect(fxAt(r.song, "pulse1", 4)).toEqual(["arp:0,0"]);
    // and the notes after it carry nothing
    expect(fxAt(r.song, "pulse1", 6)).toEqual([]);
    // the other channels did not get anything
    expect(rowsOf(r.song, "pulse2").every((x) => x.fx.length === 0)).toBe(true);
    // converted, not lost: one info line, no dropped warning
    expect(infos(r)).toEqual(["1 chord on Lead became an arpeggio on pulse1"]);
    expect(dropped(r)).toEqual([]);
  });

  it("writes the arpeggio in the song's string form", () => {
    const r = midiToSong(arrangement([60, 64, 67]), { chip: "nes" });
    const pat = r.song.patterns[r.song.order[0] ?? ""];
    expect(
      pat?.tracks.pulse1?.[0]?.fx.map((f) => `${f.type}${f.x}${f.y}`)
    ).toEqual(["arp47"]);
  });

  it("ends the arpeggio with the note off when the chord is followed by a rest", () => {
    // a chord of one beat, a gap, and a note: the note off after the chord stops the arp, so the later note needs no 000
    const lead = trackAbs(
      ...[60, 64, 67].flatMap((n): [number, number[]][] => [
        [0, [ON, n, 100]],
        [96, [ON, n, 0]],
      ]),
      [192, [ON, 72, 100]],
      [240, [ON, 72, 0]]
    );
    // one melodic part: pulse2 is free and would take a note, so ask for arpeggios only
    const only = midiToSong(smf(0, 96, track(...lead)), {
      chip: "nes",
      chords: "arpeggio",
    });
    expect(notesOn(only.song, "pulse1")).toEqual([
      [0, 60],
      [4, "off"],
      [8, 72],
      // the last note of the song ends one row early, so it cannot leak into the loop
      [9, "off"],
    ]);
    expect(fxAt(only.song, "pulse1", 0)).toEqual(["arp:4,7"]);
    expect(fxAt(only.song, "pulse1", 8)).toEqual([]);
  });

  it("keeps the third and the seventh of a four note chord, and says what it dropped", () => {
    // C7 = C E G Bb: the arpeggio plays C, +4 (E), +10 (Bb); the fifth is the part of the chord that can go
    const r = midiToSong(arrangement([60, 64, 67, 70]), { chip: "nes" });
    expect(notesOn(r.song, "pulse1")[0]).toEqual([0, 60]);
    expect(fxAt(r.song, "pulse1", 0)).toEqual(["arp:4,10"]);
    expect(dropped(r)).toEqual([
      "pulse1: 1 chord notes dropped (an arpeggio holds three notes, and a pitch that repeats is not played twice), first at bar 1 beat 1",
    ]);
    expect(infos(r)).toEqual(["1 chord on Lead became an arpeggio on pulse1"]);
  });

  it("folds the intervals of a chord that spans octaves down to fit 0 to 15", () => {
    // C4, E5, G6: +16 and +31 semitones become +4 and +7
    const r = midiToSong(arrangement([60, 76, 91]), { chip: "nes" });
    expect(notesOn(r.song, "pulse1")[0]).toEqual([0, 60]);
    expect(fxAt(r.song, "pulse1", 0)).toEqual(["arp:4,7"]);
    expect(infos(r)).toEqual([
      "1 chord on Lead became an arpeggio on pulse1; 2 arpeggio intervals folded down by octaves to fit 0 to 15 semitones",
    ]);
    // every arpeggio step an import writes is a nibble from 1 to 15
    for (const chord of [
      [48, 72, 100],
      [60, 62, 63],
      [40, 52, 64, 76],
    ]) {
      const { song } = midiToSong(arrangement(chord), { chip: "nes" });
      const arp = rowsOf(song, "pulse1")
        .flatMap((x) => x.fx)
        .filter((f) => f.type === "arp" && (f.x > 0 || f.y > 0));
      expect(arp.length).toBeGreaterThan(0);
      for (const f of arp) {
        expect(f.x).toBeGreaterThanOrEqual(1);
        expect(f.x).toBeLessThanOrEqual(15);
        expect(f.y).toBeGreaterThanOrEqual(1);
        expect(f.y).toBeLessThanOrEqual(15);
      }
    }
  });

  it("arpeggiates two notes as base, the interval, the interval", () => {
    expect(arpeggioOf([60, 67])).toEqual({
      base: 60,
      dropped: 0,
      folded: 0,
      x: 7,
      y: 7,
    });
    // an octave doubling is the least characteristic tone: the third and the fifth win
    expect(arpeggioOf([60, 64, 67, 72])).toMatchObject({
      dropped: 1,
      x: 4,
      y: 7,
    });
    // a minor chord with a seventh keeps the minor third and the seventh
    expect(arpeggioOf([57, 60, 64, 67])).toMatchObject({
      dropped: 1,
      x: 3,
      y: 10,
    });
    expect(arpeggioOf([60, 60])).toBeNull();
  });
});

describe("midiToSong: chords spread over free channels", () => {
  it("spreads the same triad to free FM channels as three real notes on genesis", () => {
    const r = midiToSong(arrangement([60, 64, 67]), { chip: "genesis" });
    expectValid(r);
    // the lead keeps the top note, the two others go to the first FM channels nothing plays on (fm1 is the bass, fm3 the pad)
    expect(notesOn(r.song, "fm2")[0]).toEqual([0, 67]);
    expect(notesOn(r.song, "fm4")).toEqual([
      [0, 60],
      [4, "off"],
    ]);
    expect(notesOn(r.song, "fm5")).toEqual([
      [0, 64],
      [4, "off"],
    ]);
    // no arpeggio anywhere
    for (const id of ["fm2", "fm4", "fm5"]) {
      expect(rowsOf(r.song, id).every((x) => x.fx.length === 0)).toBe(true);
    }
    // the bass, the pad and the drums keep their channels
    expect(r.parts.map((p) => [p.name, p.target])).toEqual([
      ["Lead", "fm2"],
      ["Pad", "fm3"],
      ["Bass", "fm1"],
      ["Drums", "psgNoise"],
    ]);
    // the new channels play the harmony instrument
    const inst = Object.fromEntries(
      r.song.channels.map((c) => [c.id, c.instrument])
    );
    expect(inst.fm4).toBe("midi-genesis-harmony");
    expect(inst.fm5).toBe("midi-genesis-harmony");
    expect(r.instruments["midi-genesis-harmony"]?.kind).toBe("fm");
    expect(infos(r)).toEqual(["1 chord on Lead spread to fm4 and fm5"]);
    expect(dropped(r)).toEqual([]);
  });

  it("spreads what it can and arpeggiates the rest, on a chip with one free channel", () => {
    // the NES with no pad: pulse2 is the only free channel, so the lowest note goes there and the other two arpeggiate
    const lead = trackAbs(
      ...[60, 64, 67].flatMap((n): [number, number[]][] => [
        [0, [ON, n, 100]],
        [96, [ON, n, 0]],
      ]),
      [96, [ON, 72, 100]],
      [192, [ON, 72, 0]]
    );
    const r = midiToSong(smf(0, 96, track(...lead)), { chip: "nes" });
    expect(notesOn(r.song, "pulse2")).toEqual([
      [0, 60],
      [4, "off"],
    ]);
    // the lead keeps E and G: E with +3
    expect(notesOn(r.song, "pulse1")[0]).toEqual([0, 64]);
    expect(fxAt(r.song, "pulse1", 0)).toEqual(["arp:3,3"]);
    expect(infos(r)).toEqual([
      "1 chord on t1ch1 became an arpeggio on pulse1, 1 chord spread to pulse2",
    ]);
  });

  it("never spreads onto the lead, the bass or the drum channel", () => {
    // on genesis every channel but fm2 (lead), fm1 and psgNoise is open: with chords of 8 notes the spread stops there
    const chord = [48, 52, 55, 58, 62, 65, 69, 72];
    const r = midiToSong(arrangement(chord), { chip: "genesis" });
    const used = new Set(
      Object.entries(r.song.patterns).flatMap(([, p]) => Object.keys(p.tracks))
    );
    expect(used.has("fm1")).toBe(true);
    // fm1 holds only the bass line: 36 on every beat
    expect(
      notesOn(r.song, "fm1")
        .filter(([, n]) => n !== "off")
        .every(([, n]) => n === 36)
    ).toBe(true);
    expect(
      notesOn(r.song, "psgNoise")
        .filter(([, n]) => n !== "off")
        .every(([, n]) => n === 36)
    ).toBe(true);
    // the six notes furthest from the top went to fm4 to fm6 and the PSG squares (fm3 is busy with the pad); the lead
    // keeps its top note 72 and 69, the last one, as an arpeggio on A-4 with +3
    expect(notesOn(r.song, "fm2")[0]).toEqual([0, 69]);
    expect(fxAt(r.song, "fm2", 0)).toEqual(["arp:3,3"]);
    const spread = ["fm4", "fm5", "fm6", "psg1", "psg2", "psg3"].filter(
      (id) => notesOn(r.song, id).length > 0
    );
    expect(spread).toEqual(["fm4", "fm5", "fm6", "psg1", "psg2", "psg3"]);
    expect(infos(r)[0]).toContain(
      "spread to fm4, fm5, fm6, psg1, psg2 and psg3"
    );
  });
});

describe("midiToSong: chord modes", () => {
  it('"top" keeps one note and writes no effect, as before', () => {
    const r = midiToSong(arrangement([60, 64, 67]), {
      chip: "nes",
      chords: "top",
    });
    expect(notesOn(r.song, "pulse1")[0]).toEqual([0, 67]);
    for (const id of ["pulse1", "pulse2", "triangle", "noise"]) {
      expect(rowsOf(r.song, id).every((x) => x.fx.length === 0)).toBe(true);
    }
    expect(infos(r)).toEqual([]);
    expect(dropped(r)).toEqual([
      "pulse1: 2 notes dropped (chords and notes on one row keep only the top note), first at bar 1 beat 1",
    ]);
    // genesis too: nothing spreads
    const g = midiToSong(arrangement([60, 64, 67]), {
      chip: "genesis",
      chords: "top",
    });
    expect(notesOn(g.song, "fm4")).toEqual([]);
    expect(notesOn(g.song, "fm2")[0]).toEqual([0, 67]);
  });

  it('"spread" never writes an arpeggio and drops what has no free channel', () => {
    const r = midiToSong(arrangement([60, 64, 67]), {
      chip: "nes",
      chords: "spread",
    });
    expect(notesOn(r.song, "pulse1")[0]).toEqual([0, 67]);
    expect(rowsOf(r.song, "pulse1").every((x) => x.fx.length === 0)).toBe(true);
    expect(dropped(r)).toEqual([
      "pulse1: 2 chord notes dropped (no free channel to spread them to: the channel keeps the top note), first at bar 1 beat 1",
    ]);
    const g = midiToSong(arrangement([60, 64, 67]), {
      chip: "genesis",
      chords: "spread",
    });
    expect(notesOn(g.song, "fm4")[0]).toEqual([0, 60]);
  });

  it('"arpeggio" never spreads, even when channels are free', () => {
    const r = midiToSong(arrangement([60, 64, 67]), {
      chip: "genesis",
      chords: "arpeggio",
    });
    expect(notesOn(r.song, "fm2")[0]).toEqual([0, 60]);
    expect(fxAt(r.song, "fm2", 0)).toEqual(["arp:4,7"]);
    expect(notesOn(r.song, "fm4")).toEqual([]);
    expect(infos(r)).toEqual(["1 chord on Lead became an arpeggio on fm2"]);
  });

  it("defaults to auto and rejects an unknown mode", () => {
    const base = arrangement([60, 64, 67]);
    expect(midiToSong(base, { chip: "genesis" }).song).toEqual(
      midiToSong(base, { chip: "genesis", chords: "auto" }).song
    );
    const bad = midiToSong(base, { chords: "stack" as never });
    expect(errors(bad)[0]).toContain(
      "chords must be one of auto, spread, arpeggio, top"
    );
  });

  it("counts the chords of a whole part in one line", () => {
    // 3 chords, one per beat, on the busy NES arrangement
    const lead = trackAbs(
      ...[0, 96, 192].flatMap((t): [number, number[]][] =>
        [60, 64, 67].flatMap((n): [number, number[]][] => [
          [t, [ON, n, 100]],
          [t + 90, [ON, n, 0]],
        ])
      ),
      [288, [ON, 72, 100]],
      [336, [ON, 72, 0]]
    );
    const pad = trackAbs([0, [ON | 1, 55, 70]], [576, [ON | 1, 55, 0]]);
    const bass = trackAbs(
      ...[0, 1, 2, 3, 4, 5].flatMap((i): [number, number[]][] => [
        [i * 96, [ON | 2, 36, 100]],
        [i * 96 + 60, [ON | 2, 36, 0]],
      ])
    );
    const r = midiToSong(
      smf(1, 96, track(nameEv("Piano"), ...lead), track(...pad), track(...bass))
    );
    expect(infos(r)).toEqual(["3 chords on Piano became arpeggios on pulse1"]);
  });
});

describe("midiToSong: simultaneous drums", () => {
  it("keeps the kick over the snare over toms over hats and cymbals, then the louder hit, and reports the rest", () => {
    const hit = (
      tick: number,
      note: number,
      velocity: number
    ): [number, number[]][] => [
      [tick, [DRUM_ON, note, velocity]],
      [tick + 12, [DRUM_ON, note, 0]],
    ];
    const drums = trackAbs(
      // row 0: a quiet kick and a loud closed hat
      ...hit(0, 36, 60),
      ...hit(0, 42, 127),
      // row 1: a tom and a hat
      ...hit(24, 45, 90),
      ...hit(24, 42, 127),
      // row 2: a snare and a tom
      ...hit(48, 38, 80),
      ...hit(48, 47, 127),
      // row 3: a closed hat and a crash: the louder one stays
      ...hit(72, 42, 50),
      ...hit(72, 49, 100),
      // row 4: kick and snare
      ...hit(96, 38, 127),
      ...hit(96, 36, 70),
      // row 5: a lone hat
      ...hit(120, 42, 100)
    );
    const r = midiToSong(smf(1, 96, track(...drums)));
    expect(notesOn(r.song, "noise").filter(([, n]) => n !== "off")).toEqual([
      [0, 36],
      [1, 45],
      [2, 62],
      [3, 96],
      [4, 36],
      [5, 84],
    ]);
    expect(r.issues.find((i) => i.path === "/channels/noise")?.message).toBe(
      "noise: 5 drum hits dropped (one drum per row: the kick wins over the snare, toms, then hats and cymbals; equal drums keep the louder hit), first at bar 1 beat 1"
    );
  });
});

describe("chord placement", () => {
  const host = (
    id: string,
    order: number,
    events: ChordHost["events"],
    chords: Chord[] = [],
    open = true
  ): ChordHost => ({
    chords,
    events,
    id,
    kind: "fm",
    loss: {
      dropped: 0,
      firstDropped: null,
      folded: 0,
      shiftOctaves: 0,
      shortened: 0,
    },
    open,
    order,
    range: [21, 105],
  });
  const chord = (
    row: number,
    end: number,
    primary: number,
    ...extras: number[]
  ): Chord => ({
    end,
    extras: extras.map((note) => ({
      end,
      note,
      tick: row * 24,
      velocity: 100,
    })),
    primary,
    row,
  });

  it("prefers a channel that stays free for the whole chord, then the plan's order", () => {
    // fm3 is free now but starts a note on row 2; fm4 is free for the whole chord
    const lead = host(
      "fm2",
      0,
      [
        { note: 67, row: 0, velocity: 100 },
        { note: "off", row: 4, velocity: 0 },
      ],
      [chord(0, 4, 67, 60)],
      false
    );
    const fm3 = host("fm3", 1, [
      { note: 50, row: 2, velocity: 100 },
      { note: "off", row: 3, velocity: 0 },
    ]);
    const fm4 = host("fm4", 2, []);
    placeChords([lead, fm3, fm4], "auto");
    expect(fm4.events).toEqual([
      { note: 60, row: 0, velocity: 100 },
      { note: "off", row: 4, velocity: 0 },
    ]);
    expect(fm3.events).toHaveLength(2);
  });

  it("cuts a spread note short where its channel is needed again, and counts it", () => {
    const lead = host(
      "fm2",
      0,
      [
        { note: 67, row: 0, velocity: 100 },
        { note: "off", row: 4, velocity: 0 },
      ],
      [chord(0, 4, 67, 60)],
      false
    );
    const fm3 = host("fm3", 1, [
      { note: 50, row: 2, velocity: 100 },
      { note: "off", row: 3, velocity: 0 },
    ]);
    placeChords([lead, fm3], "auto");
    expect(fm3.events).toEqual([
      { note: 60, row: 0, velocity: 100 },
      { note: 50, row: 2, velocity: 100 },
      { note: "off", row: 3, velocity: 0 },
    ]);
    expect(fm3.loss.shortened).toBe(1);
  });

  it("does not take a channel that is sounding, even one that started before the chord", () => {
    const lead = host(
      "fm2",
      0,
      [
        { note: 67, row: 4, velocity: 100 },
        { note: "off", row: 6, velocity: 0 },
      ],
      [chord(4, 6, 67, 60)],
      false
    );
    const pad = host("fm3", 1, [
      { note: 50, row: 0, velocity: 100 },
      { note: "off", row: 8, velocity: 0 },
    ]);
    placeChords([lead, pad], "auto");
    expect(pad.events).toHaveLength(2);
    // the chord arpeggiates instead: E-G style, base 60 with +7
    expect(lead.events[0]).toMatchObject({
      fx: [{ type: "arp", x: 7, y: 7 }],
      note: 60,
    });
  });
});

/* ---------- it plays ---------- */

describe("midiToSong: the result renders", () => {
  it("renders sound on the NES channels the parts went to", () => {
    const r = midiToSong(tune(), { loop: false });
    const out = renderSong(r.song, r.instruments, {
      sampleRate: 22_050,
      stems: true,
      tail: 0.2,
    });
    const peakOf = (id: string) => {
      const i = out.stemIds?.indexOf(id) ?? -1;
      let p = 0;
      for (const v of out.stems?.[i] ?? []) {
        p = Math.max(p, Math.abs(v));
      }
      return p;
    };
    for (const id of ["pulse1", "pulse2", "triangle", "noise"]) {
      expect(peakOf(id), id).toBeGreaterThan(0.01);
    }
    expect(
      out.events.filter((e) => e.type === "noteOn").length
    ).toBeGreaterThan(10);
  });
});
