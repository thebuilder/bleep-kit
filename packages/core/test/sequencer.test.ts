import { describe, expect, it } from "vitest";
import { SongPlayer } from "../src/engine/sequencer.ts";
import { compileSong } from "../src/engine/timeline.ts";
import type { Effect, Instrument, Row, Song } from "../src/index.ts";
import {
  createSynth,
  defaultInstrument,
  defaultSong,
  normalizeSong,
  noteToHz,
} from "../src/index.ts";
import { hashChannels, rms, runSynth, zeroCrossingHz } from "./helpers.ts";

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

  it("play from an order and row skips the entries before it", () => {
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

/* Tracker effects are measured on the audio: the pitch of each 1/60 s tick from its zero crossings, the level from its
   rms. A tick lasts 800 frames at 48 kHz, tick k starts at frame 800 * k, and the state of tick k is what the effect
   has built up after k tick updates. */
describe("tracker effects per tick", () => {
  const TICK = 800;
  const BASE = 60;

  function render(
    rows: Row[],
    ticks: number,
    inst: Instrument = simpleInstrument(),
    extra: Partial<Song> = {}
  ) {
    const synth = createSynth({ sampleRate: SR });
    synth.loadSong(customSong(rows, extra), { lead: inst });
    synth.play({ loop: false });
    return runSynth(synth, TICK * ticks);
  }

  /** Tick t of the audio without its first 120 frames (the limiter's lookahead delay and the declick ramps). */
  const tickOf = (left: Float32Array, t: number) =>
    left.subarray(TICK * t + 120, TICK * (t + 1) - 10);

  /** Pitch of ticks from..from+count-1 in cents above `base`, from the zero crossings of each tick. */
  function cents(rows: Row[], from: number, count: number, base = BASE) {
    const { left } = render(rows, from + count);
    return Array.from(
      { length: count },
      (_, i) =>
        1200 *
        Math.log2(zeroCrossingHz(tickOf(left, from + i), SR) / noteToHz(base))
    );
  }

  /** The zero crossing count of a few cycles is good to about 5 cents. */
  function expectCents(got: number[], want: number[]) {
    expect(got).toHaveLength(want.length);
    for (let i = 0; i < want.length; i += 1) {
      expect(
        Math.abs((got[i] ?? 0) - (want[i] ?? 0)),
        `tick ${i}: ${got[i]?.toFixed(1)} cents, wanted ${want[i]}`
      ).toBeLessThan(8);
    }
  }

  /** Rms level of ticks 0..count-1. */
  function levels(rows: Row[], count: number, inst?: Instrument) {
    const { left } = render(rows, count, inst);
    return Array.from({ length: count }, (_, t) => rms(tickOf(left, t)));
  }

  const first = (fx: Effect[]) => [row(0, BASE, fx, { inst: "lead" })];

  it("arpeggio 047 cycles base, +4, +7 semitones, one step per tick", () => {
    expectCents(
      cents(first([{ type: "arp", x: 4, y: 7 }]), 0, 6),
      [0, 400, 700, 0, 400, 700]
    );
  });

  it("slide up raises the pitch by xx sixteenths of a semitone every tick", () => {
    // xx = 0x10 = 16 sixteenths: one semitone per tick
    expectCents(
      cents(first([{ type: "slideUp", x: 1, y: 0 }]), 0, 4),
      [0, 100, 200, 300]
    );
    // xx = 8: half a semitone per tick
    expectCents(
      cents(first([{ type: "slideUp", x: 0, y: 8 }]), 0, 4),
      [0, 50, 100, 150]
    );
  });

  it("slide down lowers the pitch every tick", () => {
    expectCents(
      cents(first([{ type: "slideDown", x: 1, y: 0 }]), 0, 4),
      [0, -100, -200, -300]
    );
  });

  it("pitch effect offsets the note at once by (xx - 0x80) sixteenths of a semitone", () => {
    // xx = 0x90: 16 sixteenths up; xx = 0x70: 16 down
    expectCents(
      cents(first([{ type: "pitch", x: 9, y: 0 }]), 0, 2),
      [100, 100]
    );
    expectCents(
      cents(first([{ type: "pitch", x: 7, y: 0 }]), 0, 2),
      [-100, -100]
    );
  });

  it("vibrato swings the pitch by y * 8 cents on a cycle of 64 / x ticks", () => {
    // speed 8 is one cycle in 8 ticks, depth 4 is 32 cents: a sine sampled at the tick rate
    expectCents(
      cents(first([{ type: "vibrato", x: 8, y: 4 }]), 0, 9),
      [0, 22.6, 32, 22.6, 0, -22.6, -32, -22.6, 0]
    );
  });

  it("portamento glides toward a new note at xx sixteenths of a semitone per tick, without retriggering", () => {
    const rows = [
      row(0, 60, [{ type: "portamento", x: 0, y: 8 }], { inst: "lead" }),
      row(2, 64),
    ];
    // row 2 starts at frame 12000, the start of tick 15: half a semitone per tick up to 4 semitones, then it holds
    expectCents(
      cents(rows, 15, 11),
      [0, 50, 100, 150, 200, 250, 300, 350, 400, 400, 400]
    );
    const { events } = render(rows, 30);
    expect(events.filter((e) => e.type === "noteOn")).toHaveLength(1);
  });

  it.each([
    ["noteSlideUp", 1],
    ["noteSlideDown", -1],
  ] as const)(
    "%s glides y semitones at x * 2 sixteenths per tick and stops there",
    (type, sign) => {
      // speed 4 is half a semitone per tick, so the 4 semitones take 8 ticks
      expectCents(
        cents(first([{ type, x: 4, y: 4 }]), 0, 11),
        [0, 50, 100, 150, 200, 250, 300, 350, 400, 400, 400].map(
          (c) => c * sign
        )
      );
    }
  );

  it("a note slide with a zero speed or distance does nothing", () => {
    expectCents(
      cents(first([{ type: "noteSlideUp", x: 0, y: 4 }]), 0, 4),
      [0, 0, 0, 0]
    );
    expectCents(
      cents(first([{ type: "noteSlideUp", x: 4, y: 0 }]), 0, 4),
      [0, 0, 0, 0]
    );
  });

  it("cut (Sxx) releases after xx ticks", () => {
    const { events } = render(first([{ type: "cut", x: 0, y: 3 }]), 6);
    const off = events.find((e) => e.type === "noteOff");
    expect(off?.frame).toBe(TICK * 3);
  });

  it("delay (Gxx) triggers the note xx ticks late", () => {
    const { events } = render(first([{ type: "delay", x: 0, y: 2 }]), 6);
    expect(events.find((e) => e.type === "noteOn")?.frame).toBe(TICK * 2);
  });

  it("tremolo swings the level between full and silence: depth y / 15 at speed x / 64 cycles per tick", () => {
    // speed 8 is one cycle in 8 ticks, depth 15 is the full volume: gain = 0.5 + 0.5 cos(2 pi t / 8)
    const got = levels(first([{ type: "tremolo", x: 8, y: 15 }]), 17);
    const top = got[0] ?? 1;
    const want = Array.from(
      { length: 17 },
      (_, t) => 0.5 + 0.5 * Math.cos((2 * Math.PI * t) / 8)
    );
    for (let t = 0; t < 17; t += 1) {
      expect(
        Math.abs((got[t] ?? 0) / top - (want[t] ?? 0)),
        `tick ${t}`
      ).toBeLessThan(0.05);
    }
  });

  it("volume slide Axy moves the volume by x - y sixteenths per tick", () => {
    // A04: a quarter of the volume less per tick, silent after four ticks
    const got = levels(first([{ type: "volSlide", x: 0, y: 4 }]), 7);
    const top = got[0] ?? 1;
    const ratios = got.map((v) => v / top);
    [1, 0.75, 0.5, 0.25, 0, 0, 0].forEach((want, t) => {
      expect(Math.abs((ratios[t] ?? 0) - want), `tick ${t}`).toBeLessThan(0.05);
    });
  });

  it.each([
    [0, 0.125],
    [1, 0.25],
    [2, 0.5],
    [3, 0.75],
  ])(
    "duty effect %i picks the pulse width %f from the duty list",
    (index, duty) => {
      const { left } = render(first([{ type: "duty", x: 0, y: index }]), 40);
      let high = 0;
      for (let i = 6000; i < 30_000; i += 1) {
        if ((left[i] ?? 0) > 0) {
          high += 1;
        }
      }
      expect(Math.abs(high / 24_000 - duty)).toBeLessThan(0.02);
    }
  );

  it("pan effect moves the sound to one side", () => {
    const side = (xx: number) => {
      const { left, right } = render(
        first([{ type: "pan", x: xx >> 4, y: xx & 15 }]),
        4
      );
      return [rms(left), rms(right)] as const;
    };
    const [leftOnly, silentRight] = side(0x00);
    expect(leftOnly).toBeGreaterThan(0.01);
    expect(silentRight).toBeLessThan(leftOnly * 0.05);
    const [silentLeft, rightOnly] = side(0xff);
    expect(rightOnly).toBeGreaterThan(0.01);
    expect(silentLeft).toBeLessThan(rightOnly * 0.05);
  });

  it("send effect sets the voice's echo send to xx / 255, on the same scale as the instrument's own send", () => {
    // a 3 tick note and an echo 0.1 s behind it: its repeat sounds in the window after the note and its release are over
    const master = {
      ...defaultSong("custom").master,
      echo: { delay: 0.1, feedback: 0, level: 1, lowpassHz: 20_000 },
    };
    const echoLevel = (xx: number | null, instrumentSend = 0) => {
      const inst = simpleInstrument();
      inst.send = { echo: instrumentSend, reverb: 0 };
      const fx: Effect[] = [{ type: "cut", x: 0, y: 3 }];
      if (xx !== null) {
        fx.push({ type: "send", x: xx >> 4, y: xx & 15 });
      }
      const { left } = render(first(fx), 15, inst, { master });
      return rms(left, Math.round(0.11 * SR), Math.round(0.14 * SR));
    };
    // W80 is 128 / 255 of a full send: as loud as an instrument send of 0.5
    const half = echoLevel(null, 0.5);
    expect(half).toBeGreaterThan(0.05);
    expect(echoLevel(0x80) / half).toBeCloseTo(1, 1);
    // an effect wins over the instrument, so W00 shuts a send of 0.5 and WFF opens a send of 0
    expect(echoLevel(0x00, 0.5)).toBeLessThan(half * 0.01);
    expect(echoLevel(0xff) / half).toBeCloseTo(2, 0);
  });

  it("retrigger restarts the note every xx ticks", () => {
    // a note that dies away over 0.3 s: without Hxx every tick is quieter than the last, with H02 every second tick is
    // a fresh attack
    const dying = simpleInstrument();
    dying.envelope = { attack: 0, decay: 0.3, release: 0.05, sustain: 0 };
    const plain = levels(first([]), 9, dying);
    const again = levels(first([{ type: "retrigger", x: 0, y: 2 }]), 9, dying);
    expect(plain[8]).toBeLessThan((plain[0] ?? 0) * 0.1);
    for (const t of [2, 4, 6, 8]) {
      expect(again[t]).toBeGreaterThan((again[0] ?? 0) * 0.9);
    }
    // the ticks between are the decay of the restarted note
    expect(again[1]).toBeCloseTo(plain[1] ?? 0, 2);
  });

  describe("persistent effects", () => {
    it("stay on over the following rows' notes", () => {
      const rows = [
        row(0, 60, [{ type: "arp", x: 4, y: 7 }], { inst: "lead" }),
        row(1, 62),
      ];
      // row 1 starts at frame 6000 (tick 7.5): ticks 8 to 13 are inside it and still cycle through the chord
      const during = cents(rows, 8, 6, 62).map((c) => Math.round(c / 100));
      expect(new Set(during)).toEqual(new Set([0, 4, 7]));
    });

    it("stop where the same letter appears with 00", () => {
      const rows = [
        row(0, 60, [{ type: "vibrato", x: 8, y: 4 }], { inst: "lead" }),
        row(2, 60, [{ type: "vibrato", x: 0, y: 0 }]),
      ];
      // row 2 starts at frame 12000, the start of tick 15
      expectCents(cents(rows, 1, 3), [22.6, 32, 22.6]);
      expectCents(cents(rows, 16, 5), [0, 0, 0, 0, 0]);
    });

    it("arpeggio stops at 000", () => {
      const rows = [
        row(0, 60, [{ type: "arp", x: 4, y: 7 }], { inst: "lead" }),
        row(2, 60, [{ type: "arp", x: 0, y: 0 }]),
      ];
      expectCents(cents(rows, 12, 3), [0, 400, 700]);
      expectCents(cents(rows, 16, 5), [0, 0, 0, 0, 0]);
    });

    it("end at a note off", () => {
      const rows = [
        row(0, 60, [{ type: "arp", x: 4, y: 7 }], { inst: "lead" }),
        row(1, "off"),
        row(2, 62),
      ];
      expectCents(cents(rows, 16, 4, 62), [0, 0, 0, 0]);
    });
  });
});
