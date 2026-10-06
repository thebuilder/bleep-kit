/* What each chip can carry from a MIDI file: which channel plays the bass, which one the drums, which ones take
   melodies, and the pitch range of every channel kind. Data only. */

import type { ChannelKind, ChipId } from "../types.ts";

export interface ChipPlan {
  /** Bass channel: gets the lowest-pitched busy part, one note at a time (the lowest of a chord). */
  bass: string;
  /** Drum channel: gets MIDI channel 10, in the form that suits the chip (noise, a noise voice, FM or samples). */
  drums: string;
  /** The drum channel plays a melody when the file has no drums (a SID voice, an FM voice or a sample voice). */
  drumsFlex: boolean;
  /** Melodic channels in the order they are filled: the first one is the lead. */
  melodic: readonly string[];
}

const fm = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `fm${from + i}`);
const samples = (to: number): string[] =>
  Array.from({ length: to }, (_, i) => `ch${i + 1}`);

export const PLANS: Readonly<Record<Exclude<ChipId, "custom">, ChipPlan>> = {
  adlib: { bass: "fm1", drums: "fm9", drumsFlex: true, melodic: fm(2, 8) },
  c64: {
    bass: "voice2",
    drums: "voice3",
    drumsFlex: true,
    melodic: ["voice1"],
  },
  gameboy: {
    bass: "wave",
    drums: "noise",
    drumsFlex: false,
    melodic: ["pulse1", "pulse2"],
  },
  genesis: {
    bass: "fm1",
    drums: "psgNoise",
    drumsFlex: false,
    melodic: [...fm(2, 6), "psg1", "psg2", "psg3"],
  },
  nes: {
    bass: "triangle",
    drums: "noise",
    drumsFlex: false,
    melodic: ["pulse1", "pulse2"],
  },
  snes: {
    bass: "ch7",
    drums: "ch8",
    drumsFlex: true,
    melodic: samples(6),
  },
};

export type Range = readonly [low: number, high: number];

const FM_RANGE: Range = [21, 105];
const FREE_RANGE: Range = [24, 96];

/** The MIDI notes a channel plays well: the period registers set the floor, a musical ceiling the top. */
export function channelRange(
  chip: ChipId,
  channelId: string,
  kind: ChannelKind
): Range {
  if (kind === "triangle") {
    return [21, 96];
  }
  if (kind === "wave") {
    return [24, 96];
  }
  if (kind === "pulse") {
    return pulseRange(chip, channelId);
  }
  if (kind === "sid") {
    return [24, 105];
  }
  return kind === "fm" ? FM_RANGE : FREE_RANGE;
}

function pulseRange(chip: ChipId, channelId: string): Range {
  if (chip === "genesis" && channelId.startsWith("psg")) {
    // the PSG divider is 10 bits: A2 is the lowest note it reaches
    return [45, 108];
  }
  return chip === "gameboy" ? [36, 108] : [33, 108];
}

export interface DrumVoice {
  /** Sample generator on the sample chip. */
  generator: "kick" | "snare" | "hat" | "tom" | "crash" | "clap";
  /** The note a drum hit plays on a pitched drum channel (noise period, SID noise, FM voice): low is a thud, high is a hiss. */
  pitch: number;
  /** When two drums hit on the same row only one fits a channel: the higher priority stays (kick, snare, toms, then hats and cymbals; equal priority goes to the louder hit). */
  priority: number;
}

const KICK: DrumVoice = { generator: "kick", pitch: 36, priority: 6 };
const SNARE: DrumVoice = { generator: "snare", pitch: 62, priority: 5 };
const CLAP: DrumVoice = { generator: "clap", pitch: 70, priority: 5 };
const HAT: DrumVoice = { generator: "hat", pitch: 84, priority: 2 };
const OPEN_HAT: DrumVoice = { generator: "hat", pitch: 78, priority: 2 };
const CRASH: DrumVoice = { generator: "crash", pitch: 96, priority: 2 };
const RIDE: DrumVoice = { generator: "crash", pitch: 90, priority: 2 };
const PERCUSSION: DrumVoice = { generator: "hat", pitch: 88, priority: 1 };

const GM_DRUMS: Record<number, DrumVoice> = {
  35: KICK,
  36: KICK,
  37: SNARE,
  38: SNARE,
  39: CLAP,
  40: SNARE,
  42: HAT,
  44: HAT,
  46: OPEN_HAT,
  49: CRASH,
  51: RIDE,
  52: CRASH,
  53: RIDE,
  55: CRASH,
  57: CRASH,
  59: RIDE,
};

const TOM_NOTES = [41, 43, 45, 47, 48, 50] as const;

/** The drum a General MIDI percussion note number means. Toms keep their own pitch, anything unknown is a light tick. */
export function drumVoice(note: number): DrumVoice {
  if ((TOM_NOTES as readonly number[]).includes(note)) {
    return { generator: "tom", pitch: note, priority: 3 };
  }
  return GM_DRUMS[note] ?? PERCUSSION;
}
