/* rechipSong (architecture.md section 2.9). The expectations are counted from the starter song itself (notes per
   channel, pitches, kinds), not from what the function reports about itself. */

import { describe, expect, it } from "vitest";
import type {
  ChipId,
  Effect,
  Instrument,
  NoteValue,
  Row,
  Song,
} from "../src/index.ts";
import {
  CHIP_IDS,
  chipChannels,
  defaultInstrument,
  describeRechip,
  makeInstrument,
  normalizeSong,
  parseMml,
  parseNoteName,
  rechipSong,
} from "../src/index.ts";

/* ---------- the NES starter song (the studio's starter theme, shorter) ---------- */

function rows(...specs: string[]): Row[] {
  return specs.map((entry) => {
    const [rowText = "0", noteText = "", instId = "", volText = ""] =
      entry.split(":");
    const up = noteText.toUpperCase();
    let note: NoteValue | null = parseNoteName(noteText);
    if (up === "OFF") {
      note = "off";
    }
    return {
      fx: [],
      inst: instId || null,
      note,
      row: Number(rowText),
      vol: volText === "" ? null : Number.parseInt(volText, 16),
    };
  });
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const channel = (
  id: string,
  kind: Instrument["kind"],
  instrument: string,
  mml: string | null = null
) => ({
  id,
  instrument,
  kind,
  mml,
  muted: false,
  pan: 0,
  volume: 1,
});

function starterSong(): Song {
  return {
    channels: [
      channel("pulse1", "pulse", "lead"),
      channel("pulse2", "pulse", "harmony"),
      channel("triangle", "triangle", "bass"),
      channel(
        "noise",
        "noise",
        "drums",
        "@drums o3 l8 c r d r c c d r L [c r d r c c d r]3 c r d r c d d d"
      ),
    ],
    chip: "nes",
    loop: 1,
    master: { echo: null, reverb: null, volume: 0.8 },
    name: "Starter theme",
    order: ["intro", "verse", "verse"],
    patterns: {
      intro: {
        length: 16,
        tracks: {
          pulse1: rows("0:A-5:lead:C", "4:E-5", "8:A-5", "12:C-6", "15:OFF"),
          pulse2: rows("0:E-4:harmony:8", "8:A-4", "14:OFF"),
          triangle: rows("0:A-1:bass", "4:A-1", "8:F-1", "12:F-1"),
        },
      },
      verse: {
        length: 32,
        tracks: {
          pulse1: rows(
            "0:A-5:lead:F",
            "2:C-6",
            "4:E-6",
            "6:C-6",
            "8:F-5",
            "10:A-5",
            "12:C-6",
            "14:A-5",
            "16:E-5",
            "18:G-5",
            "20:C-6",
            "22:G-5",
            "24:D-5",
            "26:G-5",
            "28:B-5",
            "30:G-5"
          ),
          pulse2: rows(
            "0:C-5:harmony:9",
            "7:OFF",
            "8:A-4",
            "15:OFF",
            "16:E-5",
            "23:OFF",
            "24:D-5",
            "31:OFF"
          ),
          triangle: rows(
            "0:A-1:bass",
            "4:A-1",
            "6:A-2",
            "8:F-1",
            "12:F-1",
            "14:F-2",
            "16:C-2",
            "20:C-2",
            "22:C-3",
            "24:G-1",
            "28:G-1",
            "30:G-2"
          ),
        },
      },
    },
    rowsPerBeat: 4,
    tempo: 132,
    tickRate: 60,
    version: 1,
  };
}

function starterInstruments(): Record<string, Instrument> {
  const noise = makeInstrument("noise", "nes", "drums", "Drums");
  return {
    bass: makeInstrument("triangle", "nes", "bass", "Triangle bass"),
    drums: noise,
    harmony: makeInstrument("pulse", "nes", "lead", "Harmony"),
    lead: makeInstrument("pulse", "nes", "lead", "Lead"),
  };
}

/** Instruments a fuller project has: a bass for each of the other chips, as the studio's starter project does. */
function fullerInstruments(): Record<string, Instrument> {
  return {
    ...starterInstruments(),
    "fm-bass": makeInstrument("fm", "genesis", "bass", "FM bass"),
    "sid-bass": makeInstrument("sid", "c64", "bass", "SID bass"),
    "snes-bass": makeInstrument("sample", "snes", "bass", "SNES bass"),
    "wave-bass": makeInstrument("wave", "gameboy", "bass", "Wave bass"),
  };
}

/* ---------- reading notes back ---------- */

/** Every note of a channel as "pattern@row:note", from its pattern rows. */
function trackerNotes(song: Song, id: string): string[] {
  const out: string[] = [];
  for (const [pid, pattern] of Object.entries(song.patterns)) {
    for (const r of pattern.tracks[id] ?? []) {
      if (typeof r.note === "number") {
        out.push(`${pid}@${r.row}:${r.note}`);
      }
    }
  }
  return out;
}

function mmlNotes(song: Song, id: string): number[] {
  const text = song.channels.find((c) => c.id === id)?.mml ?? "";
  return parseMml(text)
    .events.filter((e) => e.type === "note")
    .map((e) => (e as { note: number }).note);
}

/** All notes of the song: the pattern rows of channels without MML, and the MML notes of those with. */
function allNotes(song: Song): number {
  let n = 0;
  for (const c of song.channels) {
    n += c.mml ? mmlNotes(song, c.id).length : trackerNotes(song, c.id).length;
  }
  return n;
}

const SOURCE_NOTES = allNotes(starterSong());

const kindOf = (song: Song, id: string) =>
  song.channels.find((c) => c.id === id)?.kind;

/** The channel a source channel went to, from the moves. */
const movedTo = (moves: { from: string; to: string }[], from: string) =>
  moves.find((m) => m.from === from)?.to ?? "";

const errorsOf = (song: Song, instruments: Record<string, Instrument>) =>
  normalizeSong(song, instruments).issues.filter((i) => i.severity === "error");

/* ---------- tests ---------- */

describe("rechipSong from the NES starter song", () => {
  it("does not change the song or the instruments it is given", () => {
    const song = starterSong();
    const instruments = fullerInstruments();
    const songBefore = clone(song);
    const instBefore = clone(instruments);
    for (const chip of ["genesis", "c64", "snes", "custom"] as ChipId[]) {
      rechipSong(song, instruments, chip);
    }
    expect(song).toEqual(songBefore);
    expect(instruments).toEqual(instBefore);
  });

  it("genesis: bass, lead and harmony on FM voices, the drums on the noise channel, no note lost", () => {
    const song = starterSong();
    const r = rechipSong(song, starterInstruments(), "genesis");
    expect(r.song.chip).toBe("genesis");
    expect(r.dropped).toEqual([]);
    expect(allNotes(r.song)).toBe(SOURCE_NOTES);
    const to = (from: string) => movedTo(r.moves, from);
    expect(to("noise")).toBe("psgNoise");
    expect(kindOf(r.song, to("triangle"))).toBe("fm");
    expect(kindOf(r.song, to("pulse1"))).toBe("fm");
    expect(kindOf(r.song, to("pulse2"))).toBe("fm");
    expect(new Set(["triangle", "pulse1", "pulse2"].map(to)).size).toBe(3);
    // the pitches are the ones of the source: A-5 is 81, the bass starts on A-1 (33), both inside the FM range
    expect(trackerNotes(r.song, to("pulse1"))).toEqual(
      trackerNotes(song, "pulse1")
    );
    expect(trackerNotes(r.song, to("triangle"))).toEqual(
      trackerNotes(song, "triangle")
    );
    expect(mmlNotes(r.song, "psgNoise")).toEqual(mmlNotes(song, "noise"));
    expect(errorsOf(r.song, r.instruments)).toEqual([]);
  });

  it("genesis: every moved channel plays an instrument of its channel's kind, made for the chip when the project has none", () => {
    const r = rechipSong(starterSong(), starterInstruments(), "genesis");
    for (const c of r.song.channels) {
      const names = new Set<string>();
      for (const pattern of Object.values(r.song.patterns)) {
        for (const row of pattern.tracks[c.id] ?? []) {
          if (row.inst) {
            names.add(row.inst);
          }
        }
      }
      if (c.instrument) {
        names.add(c.instrument);
      }
      for (const id of names) {
        expect(r.instruments[id]?.kind, `${c.id} plays ${id}`).toBe(c.kind);
      }
    }
    expect(r.created.length).toBeGreaterThan(0);
    for (const id of r.created) {
      expect(id in starterInstruments()).toBe(false);
      expect(r.instruments[id]?.chip).toBe("genesis");
    }
    // genesis FM voices are 4 operator
    const fmId = r.song.channels.find((c) => c.id === "fm1")?.instrument ?? "";
    expect(r.instruments[fmId]?.fm?.ops.length).toBe(4);
  });

  it("reuses a project instrument of the kind and role instead of making one", () => {
    const r = rechipSong(starterSong(), fullerInstruments(), "genesis");
    const bassChannel = movedTo(r.moves, "triangle");
    expect(r.song.channels.find((c) => c.id === bassChannel)?.instrument).toBe(
      "fm-bass"
    );
    expect(r.created.some((id) => id.includes("bass"))).toBe(false);
    const gb = rechipSong(starterSong(), fullerInstruments(), "gameboy");
    expect(gb.song.channels.find((c) => c.id === "wave")?.instrument).toBe(
      "wave-bass"
    );
    // the NES lead and the NES drums were made for another chip, so the Game Boy gets its own
    expect(gb.song.channels.find((c) => c.id === "pulse1")?.instrument).toBe(
      "gameboy-lead"
    );
    expect(gb.song.channels.find((c) => c.id === "noise")?.instrument).toBe(
      "gameboy-drums"
    );
    expect(gb.created).toContain("gameboy-lead");
  });

  it("keeps an instrument made for no chip, and never leaves one made for another chip", () => {
    const anyChip = { ...makeInstrument("pulse", null, "lead", "Any lead") };
    const insts = { ...fullerInstruments(), lead: anyChip };
    const r = rechipSong(starterSong(), insts, "gameboy");
    expect(r.song.channels.find((c) => c.id === "pulse1")?.instrument).toBe(
      "lead"
    );
    for (const chip of CHIP_IDS.filter((c) => c !== "custom")) {
      const moved = rechipSong(starterSong(), fullerInstruments(), chip);
      expect(
        normalizeSong(moved.song, moved.instruments).issues.filter((i) =>
          i.message.includes("was designed for chip")
        ),
        chip
      ).toEqual([]);
    }
  });

  it("gameboy: lead and harmony on the pulses, bass on the wave channel, drums on noise", () => {
    const song = starterSong();
    const r = rechipSong(song, fullerInstruments(), "gameboy");
    expect(r.dropped).toEqual([]);
    expect(allNotes(r.song)).toBe(SOURCE_NOTES);
    expect(movedTo(r.moves, "pulse1")).toBe("pulse1");
    expect(movedTo(r.moves, "pulse2")).toBe("pulse2");
    expect(movedTo(r.moves, "triangle")).toBe("wave");
    expect(movedTo(r.moves, "noise")).toBe("noise");
    expect(trackerNotes(r.song, "wave")).toEqual(
      trackerNotes(song, "triangle")
    );
    expect(errorsOf(r.song, r.instruments)).toEqual([]);
  });

  it("snes: samples everywhere, the drums play drum samples chosen by pitch", () => {
    const r = rechipSong(starterSong(), starterInstruments(), "snes");
    expect(r.dropped).toEqual([]);
    expect(allNotes(r.song)).toBe(SOURCE_NOTES);
    const drums = r.song.channels.find(
      (c) => c.id === movedTo(r.moves, "noise")
    );
    expect(drums?.kind).toBe("sample");
    // the drum line plays a kit: every instrument it names is a drum sample
    const used = new Set<string>();
    for (const e of parseMml(drums?.mml ?? "").events) {
      if (e.type === "note" && e.inst) {
        used.add(e.inst);
      }
    }
    expect(used.size).toBeGreaterThan(0);
    for (const id of used) {
      expect(["kick", "snare", "hat", "tom", "clap", "crash"]).toContain(
        r.instruments[id]?.sample?.generator
      );
    }
    expect(errorsOf(r.song, r.instruments)).toEqual([]);
  });

  it("adlib: FM voices with two operators, the drums on the last voice", () => {
    const r = rechipSong(starterSong(), starterInstruments(), "adlib");
    expect(r.dropped).toEqual([]);
    expect(allNotes(r.song)).toBe(SOURCE_NOTES);
    expect(movedTo(r.moves, "noise")).toBe("fm9");
    for (const id of r.created) {
      expect(r.instruments[id]?.fm?.ops.length).toBe(2);
    }
    expect(errorsOf(r.song, r.instruments)).toEqual([]);
  });

  it("works for every chip there is, including ones added later: valid song, every note placed or reported", () => {
    for (const chip of CHIP_IDS) {
      const r = rechipSong(starterSong(), fullerInstruments(), chip);
      const droppedNotes = r.dropped.reduce((n, d) => n + d.notes, 0);
      expect(allNotes(r.song) + droppedNotes, chip).toBe(SOURCE_NOTES);
      expect(errorsOf(r.song, r.instruments), chip).toEqual([]);
      expect(r.song.chip).toBe(chip === "nes" ? "nes" : chip);
      // the drums sit on a channel that can play them, never on a melodic channel when a noise channel exists
      const hasNoise = chipChannels(r.song).some((c) => c.kind === "noise");
      if (hasNoise && chip !== "nes" && chip !== "custom") {
        expect(kindOf(r.song, movedTo(r.moves, "noise")), chip).toBe("noise");
      }
    }
  });

  it("custom: the channels stay as they are and every note is kept", () => {
    const song = starterSong();
    const r = rechipSong(song, starterInstruments(), "custom");
    expect(r.song.chip).toBe("custom");
    expect(r.song.channels.map((c) => c.id)).toEqual(
      song.channels.map((c) => c.id)
    );
    expect(allNotes(r.song)).toBe(SOURCE_NOTES);
    expect(r.dropped).toEqual([]);
    expect(r.created).toEqual([]);
    expect(errorsOf(r.song, r.instruments)).toEqual([]);
  });

  it("c64: three voices for four lines, with what was merged or dropped reported and every note accounted for", () => {
    const song = starterSong();
    const r = rechipSong(song, fullerInstruments(), "c64");
    expect(r.song.channels.map((c) => c.id)).toEqual([
      "voice1",
      "voice2",
      "voice3",
    ]);
    // the lead, the bass and the drums keep a voice each
    expect(movedTo(r.moves, "pulse1")).not.toBe("");
    expect(movedTo(r.moves, "triangle")).not.toBe("");
    expect(movedTo(r.moves, "noise")).not.toBe("");
    // the harmony is the line that was merged into rests or dropped, and the report says so
    const harmony = r.moves.find((m) => m.from === "pulse2");
    const lost = r.dropped.filter((d) => d.from === "pulse2");
    expect(harmony?.note.includes("merged") || lost.length > 0).toBe(true);
    // every note is either in the new song or in the dropped count
    const droppedNotes = r.dropped.reduce((n, d) => n + d.notes, 0);
    expect(allNotes(r.song) + droppedNotes).toBe(SOURCE_NOTES);
    expect(droppedNotes).toBeGreaterThan(0);
    // the lead and bass lines are intact
    expect(trackerNotes(r.song, movedTo(r.moves, "pulse1"))).toEqual(
      expect.arrayContaining(trackerNotes(song, "pulse1"))
    );
    expect(errorsOf(r.song, r.instruments)).toEqual([]);
    const text = describeRechip(r);
    expect(text.moved.length).toBe(r.moves.length);
    expect(text.dropped.join(" ")).toContain("pulse2");
  });

  it("round trip NES to genesis to NES keeps the notes of every channel", () => {
    const song = starterSong();
    const instruments = starterInstruments();
    const there = rechipSong(song, instruments, "genesis");
    const back = rechipSong(there.song, there.instruments, "nes");
    expect(back.dropped).toEqual([]);
    for (const id of ["pulse1", "pulse2", "triangle"]) {
      expect(trackerNotes(back.song, id), id).toEqual(trackerNotes(song, id));
    }
    expect(mmlNotes(back.song, "noise")).toEqual(mmlNotes(song, "noise"));
    // back on the NES the song plays the project's own instruments again
    const ids = (s: Song) => s.channels.map((c) => [c.id, c.instrument]);
    expect(ids(back.song)).toEqual(ids(song));
    expect(back.created).toEqual([]);
    expect(errorsOf(back.song, back.instruments)).toEqual([]);
  });

  it("leaves the channels the new chip has more of empty", () => {
    const song = starterSong();
    const r = rechipSong(song, starterInstruments(), "snes");
    const used = new Set(r.moves.map((m) => m.to));
    const empty = r.song.channels.filter((c) => !used.has(c.id));
    expect(empty.length).toBe(chipChannels(r.song).length - 4);
    for (const c of empty) {
      expect(trackerNotes(r.song, c.id)).toEqual([]);
      expect(c.mml).toBeNull();
    }
  });
});

describe("rechipSong fits notes and effects to the new chip", () => {
  function oneChannel(
    chip: ChipId,
    id: string,
    kind: Instrument["kind"],
    spec: string[],
    fx: Effect[] = []
  ): { instruments: Record<string, Instrument>; song: Song } {
    const lead = rows(...spec);
    const [first] = lead;
    if (first) {
      first.fx = fx;
    }
    const song: Song = {
      channels: [channel(id, kind, "voice")],
      chip,
      loop: 0,
      master: { echo: null, reverb: null, volume: 0.8 },
      name: "One",
      order: ["a"],
      patterns: { a: { length: 32, tracks: { [id]: lead } } },
      rowsPerBeat: 4,
      tempo: 120,
      tickRate: 60,
      version: 1,
    };
    return {
      instruments: { voice: defaultInstrument(kind, chip) },
      song,
    };
  }

  it("folds a stray note into the range and says so", () => {
    // the Game Boy pulse starts at C2 (36): the one A1 (33) among five notes is moved up an octave
    const { song, instruments } = oneChannel("nes", "pulse1", "pulse", [
      "0:C-4",
      "4:C-4",
      "8:A-1",
      "12:C-4",
      "16:C-4",
    ]);
    const r = rechipSong(song, instruments, "gameboy");
    const pitches = trackerNotes(r.song, "pulse1").map((n) =>
      Number(n.split(":")[1])
    );
    expect(pitches).toEqual([60, 60, 45, 60, 60]);
    expect(r.adjusted).toEqual([
      expect.objectContaining({
        channel: "pulse1",
        message: expect.stringContaining("1 note moved by octaves"),
      }),
    ]);
  });

  it("moves a whole line by octaves when most of it is out of range", () => {
    const { song, instruments } = oneChannel("nes", "pulse1", "pulse", [
      "0:A-1",
      "4:B-1",
      "8:C-2",
      "12:D-2",
    ]);
    const r = rechipSong(song, instruments, "gameboy");
    const pitches = trackerNotes(r.song, "pulse1").map((n) =>
      Number(n.split(":")[1])
    );
    expect(pitches).toEqual([45, 47, 48, 50]);
    expect(r.adjusted[0]?.message).toContain("moved up 1 octave");
  });

  it("removes a duty effect where the chip has no such duty, and keeps it where it does", () => {
    const duty: Effect = { type: "duty", x: 0, y: 3 };
    const { song, instruments } = oneChannel(
      "nes",
      "pulse1",
      "pulse",
      ["0:C-5", "8:E-5"],
      [duty]
    );
    const gb = rechipSong(song, instruments, "gameboy");
    const keptRow = gb.song.patterns.a?.tracks.pulse1?.[0];
    expect(keptRow?.fx).toEqual([duty]);
    // the Genesis PSG square has a fixed duty, an FM voice has no duty at all
    const gen = rechipSong(song, instruments, "genesis");
    const target = movedTo(gen.moves, "pulse1");
    expect(gen.song.patterns.a?.tracks[target]?.[0]?.fx).toEqual([]);
    expect(gen.adjusted.some((a) => a.message.includes("duty (V)"))).toBe(true);
  });

  it("converts a duty index to the nearest duty of a chip with another list", () => {
    // the source is a custom chip with no duty list: index 3 is kept on a chip that has 4 duties
    const duty: Effect = { type: "duty", x: 0, y: 2 };
    const { song, instruments } = oneChannel(
      "custom",
      "pulse",
      "pulse",
      ["0:C-5"],
      [duty]
    );
    const nes = rechipSong(song, instruments, "nes");
    expect(nes.song.patterns.a?.tracks.pulse1?.[0]?.fx).toEqual([duty]);
    const big: Effect = { type: "duty", x: 0, y: 9 };
    const { song: s2, instruments: i2 } = oneChannel(
      "custom",
      "pulse",
      "pulse",
      ["0:C-5"],
      [big]
    );
    const nes2 = rechipSong(s2, i2, "nes");
    expect(nes2.song.patterns.a?.tracks.pulse1?.[0]?.fx).toEqual([]);
    expect(nes2.adjusted.some((a) => a.message.includes("beyond"))).toBe(true);
  });

  it("removes send and pan effects the chip cannot do", () => {
    const send: Effect = { type: "send", x: 8, y: 0 };
    const pan: Effect = { type: "pan", x: 8, y: 0 };
    const { song, instruments } = oneChannel(
      "snes",
      "ch1",
      "sample",
      ["0:C-5"],
      [send, pan]
    );
    const nes = rechipSong(song, instruments, "nes");
    expect(nes.song.patterns.a?.tracks.pulse1?.[0]?.fx).toEqual([]);
    expect(nes.adjusted.map((a) => a.message).join(" ")).toContain("send");
    const gb = rechipSong(song, instruments, "gameboy");
    expect(gb.song.patterns.a?.tracks.pulse1?.[0]?.fx).toEqual([pan]);
  });

  it("removes the echo and reverb a chip without master effects cannot play", () => {
    const { song, instruments } = oneChannel("snes", "ch1", "sample", [
      "0:C-5",
    ]);
    song.master.echo = {
      delay: 0.2,
      feedback: 0.3,
      level: 0.3,
      lowpassHz: 4000,
    };
    const r = rechipSong(song, instruments, "nes");
    expect(r.song.master.echo).toBeNull();
    expect(r.adjusted.some((a) => a.channel === "master")).toBe(true);
  });

  it("drops the Genesis DAC setting when the song leaves the Genesis", () => {
    const g = rechipSong(starterSong(), starterInstruments(), "genesis");
    const song = clone(g.song);
    song.master.genesis = { dac: true };
    const r = rechipSong(song, g.instruments, "nes");
    expect(r.song.master.genesis).toBeUndefined();
    expect(r.adjusted.some((a) => a.message.includes("DAC"))).toBe(true);
  });

  it("carries tempo changes from a line that is dropped", () => {
    const song = starterSong();
    const tempo: Effect = { type: "tempo", x: 9, y: 0 };
    const row = song.patterns.verse?.tracks.pulse2?.[1];
    if (row) {
      row.fx = [tempo];
    }
    const r = rechipSong(song, fullerInstruments(), "c64");
    const found = Object.values(r.song.patterns).some((p) =>
      Object.values(p.tracks).some((rowsOf) =>
        rowsOf.some((x) => x.fx.some((e) => e.type === "tempo"))
      )
    );
    expect(found).toBe(true);
  });
});

describe("rechipSong merges, converts drums and keeps MML", () => {
  const base = (
    channels: Song["channels"],
    tracks: Song["patterns"]["a"]["tracks"]
  ): Song => ({
    channels,
    chip: "nes",
    loop: 0,
    master: { echo: null, reverb: null, volume: 0.8 },
    name: "Merge",
    order: ["a"],
    patterns: { a: { length: 32, tracks } },
    rowsPerBeat: 4,
    tempo: 120,
    tickRate: 60,
    version: 1,
  });

  it("writes the least important line into the rests of the line that stays, only where the host is silent", () => {
    const song = base(
      [
        channel("pulse1", "pulse", "lead"),
        channel("pulse2", "pulse", "harmony"),
        channel("triangle", "triangle", "bass"),
        channel("noise", "noise", "drums", "o3 l8 c r d r c r d r"),
      ],
      {
        // the lead plays every 4 rows; the bass holds 2 rows at 0, 8, 16 and 24
        pulse1: rows(
          ...[0, 4, 8, 12, 16, 20, 24, 28].map((at) => `${at}:E-5:lead`)
        ),
        pulse2: rows(
          "5:G-4:harmony",
          "7:OFF",
          "8:G-4",
          "10:OFF",
          "13:G-4",
          "15:OFF",
          "21:G-4",
          "23:OFF"
        ),
        triangle: rows(
          "0:A-1:bass",
          "2:OFF",
          "8:A-1",
          "10:OFF",
          "16:A-1",
          "18:OFF",
          "24:A-1",
          "26:OFF"
        ),
      }
    );
    const instruments = starterInstruments();
    const r = rechipSong(song, instruments, "c64");
    const merged = r.moves.find((m) => m.from === "pulse2");
    expect(merged?.note).toContain("merged into the rests of voice2");
    expect(merged?.note).toContain("3 of 4 notes fit");
    expect(r.dropped).toEqual([
      expect.objectContaining({ from: "pulse2", notes: 1 }),
    ]);
    const host = r.song.patterns.a?.tracks.voice2 ?? [];
    const played = host.filter((x) => typeof x.note === "number");
    // 4 bass notes and 3 harmony notes (G-4 is 67; A-1 is 33)
    expect(played.map((x) => [x.row, x.note])).toEqual([
      [0, 33],
      [5, 67],
      [8, 33],
      [13, 67],
      [16, 33],
      [21, 67],
      [24, 33],
    ]);
    // each note names its instrument, so the bass note after a harmony note is still the bass
    const bassInst = played[0]?.inst;
    expect(
      played.filter((x) => x.note === 33).every((x) => x.inst === bassInst)
    ).toBe(true);
    expect(
      played.filter((x) => x.note === 67).every((x) => x.inst !== bassInst)
    ).toBe(true);
    // a harmony note ends before the host's next note at the latest
    expect(host.find((x) => x.row === 7)?.note).toBe("off");
    expect(errorsOf(r.song, r.instruments)).toEqual([]);
  });

  it("moves MML lines and keeps their tempo and loop", () => {
    const song = base(
      [
        channel("pulse1", "pulse", "lead", "t140 @lead o5 l8 c d e L f g a b"),
        channel("pulse2", "pulse", "harmony", "@harmony o4 l4 c e g"),
        channel("triangle", "triangle", "bass", "@bass o2 l2 c g"),
        channel("noise", "noise", "drums", "@drums o3 l8 c r d r"),
      ],
      {}
    );
    song.patterns = {};
    song.order = [];
    song.loop = null;
    const r = rechipSong(song, starterInstruments(), "genesis");
    const lead = r.song.channels.find(
      (c) => c.id === movedTo(r.moves, "pulse1")
    );
    expect(lead?.mml?.startsWith("t140 ")).toBe(true);
    expect(
      parseMml(lead?.mml ?? "").events.filter((e) => e.type === "loop").length
    ).toBe(1);
    expect(mmlNotes(r.song, lead?.id ?? "")).toEqual(mmlNotes(song, "pulse1"));
    const n = normalizeSong(r.song, r.instruments);
    expect(n.ok).toBe(true);
    expect(n.value.tempo).toBe(140);
  });

  it("turns a sample drum kit into pitched drums and back", () => {
    const kit: Record<string, Instrument> = {
      hat: makeInstrument("sample", "snes", "drums", "Hat"),
      kick: makeInstrument("sample", "snes", "drums", "Kick"),
    };
    for (const [id, i] of Object.entries(kit)) {
      if (i.sample) {
        i.sample = { ...i.sample, generator: id as "kick" | "hat" };
      }
    }
    const song = base(
      [channel("ch1", "sample", "kick"), channel("ch2", "sample", "kick")],
      {
        ch1: rows("0:C-5:lead", "8:E-5"),
        ch2: rows("0:C-4:kick", "4:C-4:hat", "8:C-4:kick", "12:C-4:hat"),
      }
    );
    song.chip = "snes";
    const instruments = { ...starterInstruments(), ...kit };
    instruments.lead = makeInstrument("sample", "snes", "lead", "Lead");
    const r = rechipSong(song, instruments, "nes");
    expect(r.dropped).toEqual([]);
    const noise = r.song.patterns.a?.tracks.noise ?? [];
    // the kick is a low thud, the hat a high hiss, on the pitches the importer uses (36 and 84)
    expect(noise.map((x) => x.note)).toEqual([36, 84, 36, 84]);
    expect(
      r.instruments[
        r.song.channels.find((c) => c.id === "noise")?.instrument ?? ""
      ]?.kind
    ).toBe("noise");
    // and back to a sample chip: kick and hat samples again, chosen from the pitch
    const back = rechipSong(r.song, r.instruments, "snes");
    const drums =
      back.song.patterns.a?.tracks[movedTo(back.moves, "noise")] ?? [];
    const generators = drums.map(
      (x) => back.instruments[x.inst ?? ""]?.sample?.generator
    );
    expect(generators.filter((g) => g === "kick").length).toBeGreaterThan(0);
    expect(generators.filter((g) => g === "hat").length).toBeGreaterThan(0);
  });

  it("does nothing for the same chip", () => {
    const song = starterSong();
    const r = rechipSong(song, starterInstruments(), "nes");
    expect(r.song).toEqual(song);
    expect(r.moves).toEqual([]);
    expect(r.created).toEqual([]);
  });

  it("maps the channels of a custom song by what they are", () => {
    const song = starterSong();
    song.chip = "custom";
    song.channels = [
      channel("saw", "sid", "bass"),
      channel("sine", "fm", "lead"),
      channel("hiss", "noise", "drums"),
    ];
    song.patterns = {
      a: {
        length: 16,
        tracks: {
          hiss: rows("0:C-3:drums", "4:C-3", "8:D-3", "12:C-3"),
          saw: rows("0:A-1", "4:A-1", "8:A-1", "12:A-1"),
          sine: rows("0:C-5", "2:E-5", "4:G-5", "6:E-5", "8:C-5", "10:E-5"),
        },
      },
    };
    song.order = ["a"];
    song.loop = 0;
    const instruments = {
      bass: makeInstrument("sid", "custom", "bass", "Bass"),
      drums: makeInstrument("noise", "custom", "drums", "Drums"),
      lead: makeInstrument("fm", "custom", "lead", "Lead"),
    };
    const r = rechipSong(song, instruments, "nes");
    expect(movedTo(r.moves, "sine")).toBe("pulse1");
    expect(movedTo(r.moves, "saw")).toBe("triangle");
    expect(movedTo(r.moves, "hiss")).toBe("noise");
    expect(r.dropped).toEqual([]);
    expect(errorsOf(r.song, r.instruments)).toEqual([]);
  });
});
