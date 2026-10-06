/* The starter project the standalone studio opens with, so it is never empty: a dozen sound effects across the
   categories, instruments of every kind (the basses are the shared bass presets) and a short demo song. Documents are
   written as plain JSON in the typed form; the studio normalizes them like any other file. */

import type {
  ChipId,
  Instrument,
  NoteValue,
  Project,
  Row,
  Sfx,
  SfxCategory,
  Song,
} from "../lib/contract.ts";
import {
  defaultInstrument,
  defaultSfx,
  makeInstrument,
  parseNoteName,
} from "../lib/core.ts";
import { choose } from "../lib/dom.ts";

type Deep<T> = {
  [K in keyof T]?: T[K] extends object
    ? T[K] extends unknown[]
      ? T[K]
      : Deep<T[K]>
    : T[K];
};

function sfx(
  id: string,
  name: string,
  category: SfxCategory,
  chip: ChipId,
  seed: number,
  patch: Deep<Sfx>
): [string, Sfx] {
  const base = defaultSfx(chip);
  const out: Sfx = { ...base, category, chip, name, seed };
  for (const [k, v] of Object.entries(patch)) {
    const cur = (out as unknown as Record<string, unknown>)[k];
    (out as unknown as Record<string, unknown>)[k] =
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      cur &&
      typeof cur === "object"
        ? { ...(cur as object), ...v }
        : v;
  }
  return [`sfx/${id}.json`, out];
}

const SFX: [string, Sfx][] = [
  sfx("coin", "Coin", "coin", "nes", 1234, {
    arpeggio: { rate: 14, steps: [7] },
    envelope: { attack: 0, decay: 0.25, punch: 0.4, sustain: 0.06 },
    frequency: { deltaSlide: 0, min: 0, slide: 0, start: 1046.5 },
    volume: 0.6,
    wave: "square",
  }),
  sfx("laser", "Laser", "laser", "nes", 88, {
    duty: { start: 0.25, sweep: -0.3 },
    envelope: { attack: 0, decay: 0.2, punch: 0.3, sustain: 0.08 },
    frequency: { deltaSlide: 0, min: 0, slide: -4.2, start: 1900 },
    volume: 0.55,
    wave: "square",
  }),
  sfx("explosion", "Explosion", "explosion", "nes", 3141, {
    envelope: { attack: 0, decay: 0.75, punch: 0.7, sustain: 0.22 },
    filter: {
      highpass: null,
      highpassSweep: 0,
      lowpass: 2600,
      lowpassSweep: -1.2,
      resonance: 0.1,
    },
    frequency: { deltaSlide: 0, min: 0, slide: -0.7, start: 120 },
    volume: 0.75,
    wave: "noise",
  }),
  sfx("powerup", "Power up", "powerup", "nes", 515, {
    duty: { start: 0.5, sweep: 0 },
    envelope: { attack: 0, decay: 0.32, punch: 0.15, sustain: 0.16 },
    frequency: { deltaSlide: 0, min: 0, slide: 2.4, start: 330 },
    vibrato: { depth: 0.25, rate: 12 },
    volume: 0.55,
    wave: "square",
  }),
  sfx("hit", "Hit", "hit", "gameboy", 9001, {
    envelope: { attack: 0, decay: 0.13, punch: 0.8, sustain: 0.03 },
    filter: {
      highpass: null,
      highpassSweep: 0,
      lowpass: 5200,
      lowpassSweep: 0,
      resonance: 0,
    },
    frequency: { deltaSlide: 0, min: 0, slide: -2.6, start: 460 },
    volume: 0.7,
    wave: "noise",
  }),
  sfx("jump", "Jump", "jump", "nes", 42, {
    duty: { start: 0.25, sweep: 0 },
    envelope: { attack: 0, decay: 0.16, punch: 0.1, sustain: 0.08 },
    frequency: { deltaSlide: 0, min: 0, slide: 2.9, start: 270 },
    volume: 0.55,
    wave: "square",
  }),
  sfx("blip", "Menu blip", "blip", "gameboy", 77, {
    envelope: { attack: 0, decay: 0.07, punch: 0, sustain: 0.03 },
    frequency: { deltaSlide: 0, min: 0, slide: 0.2, start: 880 },
    volume: 0.5,
    wave: "square",
  }),
  sfx("door", "Door", "door", "c64", 640, {
    envelope: { attack: 0.02, decay: 0.38, punch: 0, sustain: 0.24 },
    frequency: { deltaSlide: 0, min: 0, slide: -0.35, start: 150 },
    vibrato: { depth: 0.4, rate: 22 },
    volume: 0.7,
    wave: "triangle",
  }),
  sfx("alarm", "Alarm", "alarm", "genesis", 1999, {
    arpeggio: { rate: 5, steps: [-5] },
    envelope: { attack: 0, decay: 0.12, punch: 0, sustain: 0.34 },
    fm: { index: 2.6, indexDecay: 0.3, ratio: 2 },
    frequency: { deltaSlide: 0, min: 0, slide: 0, start: 660 },
    repeat: { rate: 2 },
    volume: 0.55,
    wave: "fm",
  }),
  sfx("teleport", "Teleport", "teleport", "c64", 777, {
    arpeggio: { rate: 22, steps: [12, 7, 19] },
    envelope: { attack: 0, decay: 0.45, punch: 0, sustain: 0.26 },
    filter: {
      highpass: null,
      highpassSweep: 0,
      lowpass: 6000,
      lowpassSweep: -0.6,
      resonance: 0.3,
    },
    frequency: { deltaSlide: 0, min: 0, slide: 2.4, start: 220 },
    vibrato: { depth: 0.8, rate: 28 },
    volume: 0.5,
    wave: "saw",
  }),
  sfx("step", "Footstep", "step", "nes", 12, {
    envelope: { attack: 0, decay: 0.07, punch: 0.2, sustain: 0.01 },
    filter: {
      highpass: null,
      highpassSweep: 0,
      lowpass: 1500,
      lowpassSweep: 0,
      resonance: 0,
    },
    frequency: { deltaSlide: 0, min: 0, slide: -1.3, start: 180 },
    noise: { mode: "short" },
    volume: 0.5,
    wave: "noise",
  }),
  sfx("zap", "Zap", "zap", "nes", 2468, {
    duty: { start: 0.125, sweep: 0 },
    envelope: { attack: 0, decay: 0.22, punch: 0.3, sustain: 0.06 },
    frequency: { deltaSlide: 0, min: 0, slide: -3, start: 1500 },
    vibrato: { depth: 0.6, rate: 32 },
    volume: 0.5,
    wave: "square",
  }),
];

/* ---------- instruments ---------- */

function inst(
  id: string,
  name: string,
  kind: Instrument["kind"],
  chip: ChipId | null,
  patch: Partial<Instrument>
): [string, Instrument] {
  return [
    `instruments/${id}.json`,
    { ...defaultInstrument(kind, chip), name, ...patch },
  ];
}
/** One of the shared presets (the real basses: triangle, wave table, SID, FM, sample), as a project file. */
function preset(
  id: string,
  name: string,
  kind: Instrument["kind"],
  chip: ChipId,
  which: Parameters<typeof makeInstrument>[2]
): [string, Instrument] {
  return [`instruments/${id}.json`, makeInstrument(kind, chip, which, name)];
}

const INSTRUMENTS: [string, Instrument][] = [
  inst("lead", "Lead", "pulse", "nes", {
    envelope: { attack: 0, decay: 0.15, release: 0.04, sustain: 0.6 },
    macros: {
      duty: { loop: 3, release: -1, values: [2, 2, 1, 1, 0] },
      volume: {
        loop: -1,
        release: -1,
        values: [1, 1, 0.9, 0.8, 0.75, 0.7, 0.65, 0.6],
      },
    },
    pulse: { duty: 0.5 },
  }),
  inst("harmony", "Harmony", "pulse", "nes", {
    envelope: { attack: 0.004, decay: 0.2, release: 0.08, sustain: 0.5 },
    macros: { duty: { loop: -1, release: -1, values: [1] } },
    pulse: { duty: 0.25 },
    volume: 0.6,
  }),
  preset("bass", "Triangle bass", "triangle", "nes", "bass"),
  preset("bass-pulse", "Pulse bass double", "pulse", "nes", "bass-pulse"),
  inst("drums", "Drums", "noise", "nes", {
    envelope: { attack: 0, decay: 0.09, release: 0.02, sustain: 0 },
    macros: {
      volume: { loop: -1, release: -1, values: [1, 0.8, 0.5, 0.3, 0.15, 0] },
    },
    noise: { mode: "short" },
    volume: 0.8,
  }),
  preset("wave-bass", "Wave bass", "wave", "gameboy", "bass"),
  inst("sid-pwm", "SID PWM", "sid", "c64", {
    envelope: { attack: 0.01, decay: 0.25, release: 0.15, sustain: 0.6 },
    sid: {
      filter: { cutoff: 0.45, mode: "lp", resonance: 0.3, sweep: 0 },
      pulseWidth: 0.45,
      pwmDepth: 0.4,
      pwmRate: 3,
      ring: false,
      sync: false,
      waveforms: ["pulse"],
    },
  }),
  preset("fm-bass", "FM bass", "fm", "genesis", "bass"),
  preset("sid-bass", "SID bass", "sid", "c64", "bass"),
  inst("snes-pluck", "SNES pluck", "sample", "snes", {
    envelope: { attack: 0, decay: 0.3, release: 0.2, sustain: 0.5 },
    sample: {
      baseNote: 60,
      generator: "pluck",
      loop: false,
      params: { brightness: 0.6, damp: 0.3 },
      seed: 3,
    },
    send: { echo: 0.3, reverb: 0.1 },
  }),
  preset("snes-bass", "SNES bass", "sample", "snes", "bass"),
];

/* ---------- the demo song ---------- */

/** "row:NOTE[:inst[:vol]]" to a Row; NOTE may be OFF. */
function rows(...specs: string[]): Row[] {
  return specs.map((entry) => {
    const [rowText = "0", noteText = "", instId = "", volText = ""] =
      entry.split(":");
    const up = noteText.toUpperCase();
    return {
      fx: [],
      inst: instId || null,
      note: choose<NoteValue | null>(
        [
          [up === "OFF", "off"],
          [up === "REL", "release"],
        ],
        parseNoteName(noteText)
      ),
      row: Number(rowText),
      vol: volText === "" ? null : Number.parseInt(volText, 16),
    };
  });
}

const SONG: Song = {
  channels: [
    {
      id: "pulse1",
      instrument: "lead",
      kind: "pulse",
      mml: null,
      muted: false,
      pan: 0,
      volume: 1,
    },
    {
      id: "pulse2",
      instrument: "harmony",
      kind: "pulse",
      mml: null,
      muted: false,
      pan: 0,
      volume: 0.8,
    },
    {
      id: "triangle",
      instrument: "bass",
      kind: "triangle",
      mml: null,
      muted: false,
      pan: 0,
      volume: 1,
    },
    {
      id: "noise",
      instrument: "drums",
      kind: "noise",
      mml: "@drums o3 l8 c r d r c c d r L [c r d r c c d r]7 c r d r c d d d",
      muted: false,
      pan: 0,
      volume: 0.7,
    },
  ],
  chip: "nes",
  loop: 1,
  master: { echo: null, reverb: null, volume: 0.8 },
  name: "Starter theme",
  order: ["intro", "verse", "chorus", "verse", "chorus"],
  patterns: {
    chorus: {
      length: 32,
      tracks: {
        pulse1: rows(
          "0:E-6:lead:F",
          "3:D-6",
          "4:C-6",
          "6:A-5",
          "8:C-6",
          "11:A-5",
          "12:F-5",
          "14:A-5",
          "16:G-5",
          "18:C-6",
          "20:E-6",
          "22:G-6",
          "24:D-6",
          "27:B-5",
          "28:G-5",
          "31:OFF"
        ),
        pulse2: rows(
          "0:A-4:harmony:9",
          "6:OFF",
          "8:F-4",
          "14:OFF",
          "16:C-5",
          "22:OFF",
          "24:G-4",
          "30:OFF"
        ),
        triangle: rows(
          "0:A-1:bass",
          "2:A-1",
          "4:A-2",
          "6:A-1",
          "8:F-1",
          "10:F-1",
          "12:F-2",
          "14:F-1",
          "16:C-2",
          "18:C-2",
          "20:C-3",
          "22:C-2",
          "24:G-1",
          "26:G-1",
          "28:G-2",
          "30:G-1"
        ),
      },
    },
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

export const STARTER_PROJECT: Project = {
  chip: "nes",
  export: {
    baseUrl: "/audio/",
    dir: "../public/audio",
    embed: false,
    events: true,
    manifest: "../src/audio.ts",
    mp3Bitrate: 160,
    musicFormat: "ogg",
    oggQuality: 6,
    sfxFormat: "ogg",
  },
  master: { limiter: true, volume: 0.8 },
  name: "Starter kit",
  sampleRate: 48_000,
  seed: 7,
  version: 1,
};

/** Every starter document by path, project.json included. */
export function starterFiles(): Map<string, unknown> {
  const files = new Map<string, unknown>();
  files.set("project.json", STARTER_PROJECT);
  for (const [p, d] of SFX) {
    files.set(p, d);
  }
  for (const [p, d] of INSTRUMENTS) {
    files.set(p, d);
  }
  files.set("songs/starter-theme.json", SONG);
  return files;
}
