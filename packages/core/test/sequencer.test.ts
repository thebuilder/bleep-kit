import { describe, expect, it } from "vitest";
import { DEFAULT_DUTIES } from "../src/engine/inst.ts";
import { SongPlayer } from "../src/engine/sequencer.ts";
import { SynthImpl } from "../src/engine/synth.ts";
import { compileSong } from "../src/engine/timeline.ts";
import type { Effect, Instrument, Row, Song } from "../src/index.ts";
import {
  createSynth,
  defaultInstrument,
  defaultSong,
  normalizeSong,
  noteToHz,
} from "../src/index.ts";
import { hashChannels, rms, runSynth } from "./helpers.ts";

const SR = 48_000;

function simpleInstrument(): Instrument {
  const i = defaultInstrument("pulse");
  i.envelope = { attack: 0, decay: 0.1, release: 0.05, sustain: 1 };
  return i;
}

function customSong(
  rows: Row[],
  extra: Partial<Song> = {},
  mml: string | null = null
): Song {
  const base = defaultSong("custom");
  return {
    ...base,
    channels: [
      {
        id: "pulse",
        instrument: "lead",
        kind: "pulse",
        mml,
        muted: false,
        pan: 0,
        volume: 1,
      },
    ],
    loop: null,
    order: ["a"],
    patterns: { a: { length: 16, tracks: mml ? {} : { pulse: rows } } },
    tempo: 120,
    ...extra,
  };
}

function row(
  r: number,
  note: Row["note"],
  fx: Effect[] = [],
  extra: Partial<Row> = {}
): Row {
  return { fx, inst: null, note, row: r, vol: null, ...extra };
}

describe("sequencer timing", () => {
  it.each([
    [120, 6000],
    [150, 4800],
  ])("emits noteOn at the expected frames for tempo %i", (tempo, rowFrames) => {
    const song = customSong([row(0, 60), row(4, 62), row(8, 64)], { tempo });
    const synth = createSynth({ sampleRate: SR });
    synth.loadSong(song, { lead: simpleInstrument() });
    synth.play();
    const { events } = runSynth(synth, rowFrames * 10);
    const ons = events.filter((e) => e.type === "noteOn");
    expect(ons.map((e) => e.frame)).toEqual([0, rowFrames * 4, rowFrames * 8]);
    expect(ons.map((e) => e.note)).toEqual([60, 62, 64]);
    expect(ons[0]?.hz).toBeCloseTo(noteToHz(60), 6);
    expect(ons[0]?.id).toBe("lead");
    expect(ons[0]?.channelId).toBe("pulse");
  });

  it("emits row events with the order and row, and an end event at the last frame", () => {
    const song = customSong([row(0, 60)], { tempo: 120 });
    const synth = createSynth({ sampleRate: SR });
    synth.loadSong(song, { lead: simpleInstrument() });
    synth.play();
    const { events } = runSynth(synth, 6000 * 17);
    const rows = events.filter((e) => e.type === "row");
    expect(rows).toHaveLength(16);
    expect(rows[3]).toMatchObject({ frame: 18_000, id: "a", order: 0, row: 3 });
    const end = events.find((e) => e.type === "end");
    expect(end?.frame).toBe(6000 * 16);
    expect(synth.playing).toBe(false);
  });

  it("is independent of the block size", () => {
    const song = customSong(
      [row(0, 60), row(3, 64), row(7, 67, [{ type: "arp", x: 4, y: 7 }])],
      { tempo: 133 }
    );
    const make = () => {
      const s = createSynth({ sampleRate: SR });
      s.loadSong(song, { lead: simpleInstrument() });
      s.play();
      return s;
    };
    const a = runSynth(make(), SR * 2, 128);
    const b = runSynth(make(), SR * 2, 37);
    expect(a.events).toEqual(b.events);
    expect(hashChannels([a.left])).toBe(hashChannels([b.left]));
  });

  it("changes tempo with the F effect at the row where it happens", () => {
    // 120 BPM: row = 6000 frames; at row 2 switch to 240 BPM: row = 3000 frames
    const song = customSong(
      [row(0, 60), row(2, 62, [{ type: "tempo", x: 15, y: 0 }]), row(4, 64)],
      { tempo: 120 }
    );
    const synth = createSynth({ sampleRate: SR });
    synth.loadSong(song, { lead: simpleInstrument() });
    synth.play();
    const { events } = runSynth(synth, 40_000);
    const ons = events.filter((e) => e.type === "noteOn").map((e) => e.frame);
    expect(ons).toEqual([0, 12_000, 12_000 + 2 * 3000]);
  });
});

describe("sequencer flow", () => {
  function twoPatterns(fx: Effect[], extra: Partial<Song> = {}): Song {
    const base = defaultSong("custom");
    return {
      ...base,
      channels: [
        {
          id: "pulse",
          instrument: "lead",
          kind: "pulse",
          mml: null,
          muted: false,
          pan: 0,
          volume: 1,
        },
      ],
      loop: null,
      order: ["a", "b", "c"],
      patterns: {
        a: { length: 4, tracks: { pulse: [row(0, 60), row(2, 62, fx)] } },
        b: { length: 4, tracks: { pulse: [row(0, 72)] } },
        c: { length: 4, tracks: { pulse: [row(0, 48)] } },
      },
      rowsPerBeat: 4,
      tempo: 120,
      ...extra,
    };
  }

  it("tells the handler when the first pass reaches the loop section, once, then at every wrap", () => {
    const song = twoPatterns([], { loop: 1 });
    const player = new SongPlayer(SR);
    player.load(compileSong(song, { lead: simpleInstrument() }));
    const seen: [string, number][] = [];
    const noop = () => undefined;
    const handler = {
      onEnd: (f: number) => seen.push(["end", f]),
      onEvent: noop,
      onLoop: (f: number) => seen.push(["loop", f]),
      onRow: noop,
      onSection: (f: number) => seen.push(["section", f]),
    };
    player.start(0, 0, 3, null);
    for (let frame = 0; frame <= SR * 8 && player.running; frame += 100) {
      player.advance(frame, handler);
    }
    // 120 bpm, 4 rows a beat, 4 rows a pattern: one beat (24000 frames) a pattern, the loop section starts at pattern b
    expect(seen).toEqual([
      ["section", 24_000],
      ["loop", 72_000],
      ["loop", 120_000],
      ["end", 168_000],
    ]);
  });

  it("does not announce a loop section the song starts in, or one a seek has passed", () => {
    const player = new SongPlayer(SR);
    player.load(
      compileSong(twoPatterns([], { loop: 0 }), { lead: simpleInstrument() })
    );
    const sections: number[] = [];
    const handler = {
      onEnd: () => undefined,
      onEvent: () => undefined,
      onLoop: () => undefined,
      onRow: () => undefined,
      onSection: (f: number) => sections.push(f),
    };
    player.start(0, 0, 1, null);
    for (let frame = 0; frame <= SR * 4; frame += 100) {
      player.advance(frame, handler);
    }
    expect(sections).toEqual([]);
    const later = new SongPlayer(SR);
    later.load(
      compileSong(twoPatterns([], { loop: 1 }), { lead: simpleInstrument() })
    );
    later.start(96 * 2, 0, 1, null);
    for (let frame = 0; frame <= SR * 4; frame += 100) {
      later.advance(frame, handler);
    }
    expect(sections).toEqual([]);
  });

  function notesPlayed(song: Song, seconds = 8): number[] {
    const synth = createSynth({ sampleRate: SR });
    synth.loadSong(song, { lead: simpleInstrument() });
    synth.play({ loop: false });
    const { events } = runSynth(synth, SR * seconds);
    return events.filter((e) => e.type === "noteOn").map((e) => e.note);
  }

  it("plays every order entry once without a loop", () => {
    expect(notesPlayed(twoPatterns([]))).toEqual([60, 62, 72, 48]);
  });

  it("jump (Bxx) continues at the order index after the row", () => {
    expect(notesPlayed(twoPatterns([{ type: "jump", x: 0, y: 2 }]))).toEqual([
      60, 62, 48,
    ]);
  });

  it("skip (Dxx) continues at that row of the next order entry", () => {
    const song = twoPatterns([{ type: "skip", x: 0, y: 1 }]);
    song.patterns.b = {
      length: 4,
      tracks: { pulse: [row(0, 72), row(1, 74), row(2, 76)] },
    };
    expect(notesPlayed(song)).toEqual([60, 62, 74, 76, 48]);
  });

  it("halt (Cxx) stops the song after the row", () => {
    expect(notesPlayed(twoPatterns([{ type: "halt", x: 0, y: 0 }]))).toEqual([
      60, 62,
    ]);
  });

  it("loops back to the loop order and emits loop events", () => {
    const song = twoPatterns([], { loop: 1 });
    const synth = createSynth({ sampleRate: SR });
    synth.loadSong(song, { lead: simpleInstrument() });
    synth.play();
    const { events } = runSynth(synth, SR * 6);
    const notes = events.filter((e) => e.type === "noteOn").map((e) => e.note);
    expect(notes.slice(0, 8)).toEqual([60, 62, 72, 48, 72, 48, 72, 48]);
    const loops = events.filter((e) => e.type === "loop");
    expect(loops.length).toBeGreaterThan(1);
    // a pass over orders b and c is 8 rows of 6000 frames
    expect((loops[1]?.frame ?? 0) - (loops[0]?.frame ?? 0)).toBe(8 * 6000);
  });

  it("seek moves to an order and row", () => {
    const synth = createSynth({ sampleRate: SR });
    synth.loadSong(twoPatterns([]), { lead: simpleInstrument() });
    synth.play({ loop: false, order: 1, row: 0 });
    const { events } = runSynth(synth, SR * 3);
    expect(
      events.filter((e) => e.type === "noteOn").map((e) => e.note)
    ).toEqual([72, 48]);
    expect(events.find((e) => e.type === "row")).toMatchObject({
      order: 1,
      row: 0,
    });
  });

  it("position reports the order, row and tick", () => {
    const synth = createSynth({ sampleRate: SR });
    synth.loadSong(twoPatterns([]), { lead: simpleInstrument() });
    synth.play();
    runSynth(synth, 6000 + 1700);
    const pos = synth.position();
    expect(pos?.order).toBe(0);
    expect(pos?.row).toBe(1);
    expect(pos?.tick).toBe(2);
  });
});

describe("MML and patterns", () => {
  it("produce identical noteOn events", () => {
    const mml = "o5 l16 v15 @lead c d e f g a b > c";
    const fromMml = customSong([], { loop: null }, mml);
    const rows: Row[] = [
      row(0, 72, [], { inst: "lead" }),
      row(1, 74),
      row(2, 76),
      row(3, 77),
      row(4, 79),
      row(5, 81),
      row(6, 83),
      row(7, 84),
      row(8, "off"),
    ];
    const fromPattern = customSong(rows, { loop: null });
    const events = (song: Song) => {
      const synth = createSynth({ sampleRate: SR });
      synth.loadSong(song, { lead: simpleInstrument() });
      synth.play({ loop: false });
      return runSynth(synth, SR * 2).events.filter(
        (e) => e.type === "noteOn" || e.type === "noteOff"
      );
    };
    const a = events(normalizeSong(fromMml).value);
    const b = events(fromPattern);
    expect(a.map((e) => [e.type, e.frame, e.note])).toEqual(
      b.map((e) => [e.type, e.frame, e.note])
    );
    expect(a.filter((e) => e.type === "noteOn")).toHaveLength(8);
  });
});

describe("tracker effects per tick", () => {
  function voiceHz(synth: SynthImpl): number {
    const channels = (
      synth as unknown as { channelList: { voice: { hz: number } }[] }
    ).channelList;
    return channels[0]?.voice.hz ?? 0;
  }

  function setup(fx: Effect[], extra: Partial<Row> = {}): SynthImpl {
    const synth = new SynthImpl({ sampleRate: SR });
    synth.loadSong(customSong([row(0, 60, fx, { inst: "lead", ...extra })]), {
      lead: simpleInstrument(),
    });
    synth.play({ loop: false });
    return synth;
  }

  // 60 Hz ticks at 48 kHz are 800 frames apart; tick k lands at frame 800 * k
  function hzAtTicks(synth: SynthImpl, ticks: number): number[] {
    const out: number[] = [];
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    const ev: never[] = [];
    let frame = 0;
    for (let t = 0; t < ticks; t += 1) {
      const target = 800 * t + 1;
      while (frame < target) {
        const n = Math.min(128, target - frame);
        synth.process(l, r, n, ev);
        frame += n;
      }
      out.push(voiceHz(synth));
    }
    return out;
  }

  it("arpeggio 047 cycles base, +4, +7", () => {
    const hz = hzAtTicks(setup([{ type: "arp", x: 4, y: 7 }]), 5);
    const want = [0, 4, 7, 0, 4].map((s) => noteToHz(60 + s));
    for (let i = 0; i < want.length; i += 1) {
      expect(hz[i]).toBeCloseTo(want[i] ?? 0, 3);
    }
  });

  it("slide up raises the pitch every tick", () => {
    // 1xx with xx = 16: one semitone per tick
    const hz = hzAtTicks(setup([{ type: "slideUp", x: 1, y: 0 }]), 4);
    expect(hz[0]).toBeCloseTo(noteToHz(60), 3);
    expect(hz[1]).toBeCloseTo(noteToHz(61), 3);
    expect(hz[3]).toBeCloseTo(noteToHz(63), 3);
  });

  it("pitch effect offsets the note at once", () => {
    // P xx with xx = 0x90: (0x90 - 0x80) / 16 = 1 semitone
    const hz = hzAtTicks(setup([{ type: "pitch", x: 9, y: 0 }]), 1);
    expect(hz[0]).toBeCloseTo(noteToHz(61), 3);
  });

  it("cut (Sxx) releases after xx ticks", () => {
    const synth = setup([{ type: "cut", x: 0, y: 3 }]);
    const { events } = runSynth(synth, 800 * 6);
    const off = events.find((e) => e.type === "noteOff");
    expect(off?.frame).toBe(800 * 3);
  });

  it("delay (Gxx) triggers the note xx ticks late", () => {
    const synth = setup([{ type: "delay", x: 0, y: 2 }]);
    const { events } = runSynth(synth, 800 * 6);
    expect(events.find((e) => e.type === "noteOn")?.frame).toBe(800 * 2);
  });

  it("portamento slides toward a new note without retriggering", () => {
    const song = customSong([
      row(0, 60, [{ type: "portamento", x: 0, y: 8 }], { inst: "lead" }),
      row(2, 64),
    ]);
    const synth = new SynthImpl({ sampleRate: SR });
    synth.loadSong(song, { lead: simpleInstrument() });
    synth.play({ loop: false });
    const { events } = runSynth(synth, 6000 * 4);
    expect(events.filter((e) => e.type === "noteOn")).toHaveLength(1);
    // 0.5 semitone per tick: after 12000 frames (15 ticks) the target of 4 semitones is reached
    expect(voiceHz(synth)).toBeCloseTo(noteToHz(64), 2);
  });

  /** The voice of the first channel, for the values an effect sets on it. */
  function voiceOf(synth: SynthImpl): {
    duty: number;
    generation: number;
    sendEcho: number;
  } {
    const channels = (
      synth as unknown as {
        channelList: {
          voice: { duty: number; generation: number; sendEcho: number };
        }[];
      }
    ).channelList;
    return channels[0]?.voice ?? { duty: 0, generation: 0, sendEcho: 0 };
  }

  it("slide down lowers the pitch every tick", () => {
    const hz = hzAtTicks(setup([{ type: "slideDown", x: 1, y: 0 }]), 4);
    expect(hz[1]).toBeCloseTo(noteToHz(59), 3);
    expect(hz[3]).toBeCloseTo(noteToHz(57), 3);
  });

  it("vibrato swings the pitch around the note", () => {
    const hz = hzAtTicks(setup([{ type: "vibrato", x: 8, y: 4 }]), 64);
    const base = noteToHz(60);
    expect(Math.max(...hz)).toBeGreaterThan(base * 1.001);
    expect(Math.min(...hz)).toBeLessThan(base * 0.999);
  });

  it.each([
    ["noteSlideUp", 4],
    ["noteSlideDown", -4],
  ] as const)("%s glides by y semitones and stops there", (type, semis) => {
    const hz = hzAtTicks(setup([{ type, x: 4, y: 4 }]), 20);
    expect(hz.at(-1)).toBeCloseTo(noteToHz(60 + semis), 3);
    expect(hz[0]).toBeCloseTo(noteToHz(60), 3);
  });

  it("a note slide with a zero speed or distance does nothing", () => {
    const hz = hzAtTicks(setup([{ type: "noteSlideUp", x: 0, y: 4 }]), 4);
    expect(hz.at(-1)).toBeCloseTo(noteToHz(60), 3);
  });

  /** RMS of the left channel in each 800 frame tick window. */
  function tickLevels(synth: SynthImpl, ticks: number): number[] {
    const { left } = runSynth(synth, 800 * ticks);
    const out: number[] = [];
    for (let t = 0; t < ticks; t += 1) {
      out.push(rms(left, 800 * t, 800 * (t + 1)));
    }
    return out;
  }

  it("tremolo makes the level swing", () => {
    const steady = tickLevels(setup([]), 40);
    const tremolo = tickLevels(setup([{ type: "tremolo", x: 8, y: 15 }]), 40);
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    expect(spread(tremolo)).toBeGreaterThan(spread(steady) * 5 + 0.01);
  });

  it("volume slide fades the note out", () => {
    // A04: 4/16 of the volume per tick, silent after four ticks
    const levels = tickLevels(setup([{ type: "volSlide", x: 0, y: 4 }]), 8);
    expect(levels[0]).toBeGreaterThan(0.01);
    expect(levels[6]).toBeLessThan((levels[0] ?? 1) * 0.05);
  });

  it("duty effect picks the pulse width from the duty list", () => {
    const synth = setup([{ type: "duty", x: 0, y: 1 }]);
    runSynth(synth, 800 * 2);
    expect(voiceOf(synth).duty).toBe(DEFAULT_DUTIES[1]);
  });

  it("pan effect moves the sound to one side", () => {
    const hard = (xx: number) => {
      const { left, right } = runSynth(
        setup([{ type: "pan", x: xx >> 4, y: xx & 15 }]),
        800 * 4
      );
      return [rms(left), rms(right)] as const;
    };
    const [leftOnly, silentRight] = hard(0x00);
    expect(leftOnly).toBeGreaterThan(0.01);
    expect(silentRight).toBeLessThan(leftOnly * 0.05);
    const [silentLeft, rightOnly] = hard(0xff);
    expect(rightOnly).toBeGreaterThan(0.01);
    expect(silentLeft).toBeLessThan(rightOnly * 0.05);
  });

  it("send effect sets the echo send of the voice", () => {
    const synth = setup([{ type: "send", x: 8, y: 0 }]);
    runSynth(synth, 800 * 2);
    expect(voiceOf(synth).sendEcho).toBeCloseTo(0x80 / 255, 6);
  });

  it("retrigger restarts the note every xx ticks", () => {
    const synth = setup([{ type: "retrigger", x: 0, y: 2 }]);
    runSynth(synth, 800 * 7);
    // one start from the row, then a restart at ticks 2, 4 and 6
    expect(voiceOf(synth).generation).toBeGreaterThanOrEqual(4);
    const plain = setup([]);
    runSynth(plain, 800 * 7);
    expect(voiceOf(plain).generation).toBe(1);
  });
});
