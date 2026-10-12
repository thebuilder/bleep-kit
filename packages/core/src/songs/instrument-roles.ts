/* What an instrument is for: which role its id or name says, whether it is a drum, and the drum kit of a sample chip.
   rechipSong uses these to reuse a project's own instruments instead of making new ones. */

import { type DrumVoice, drumVoice } from "../midi/plan.ts";
import type { Instrument } from "../types.ts";
import type { Role } from "./roles.ts";

const SPLIT = /[^a-z0-9]+/;
const DRUM_WORDS = new Set([
  "clap",
  "crash",
  "cymbal",
  "drum",
  "drums",
  "hat",
  "hats",
  "hihat",
  "kick",
  "noise",
  "perc",
  "percussion",
  "snare",
  "tom",
  "toms",
]);
const BASS_WORDS = new Set(["bass", "sub"]);
const LEAD_WORDS = new Set(["hook", "lead", "melody", "solo"]);
const HARMONY_WORDS = new Set([
  "arp",
  "chord",
  "chords",
  "harmony",
  "pad",
  "support",
]);

/** The role the id or the name of an instrument says ("nes-bass", "Snare roll"), or null when it says none. */
export function roleHint(id: string, name: string): Role | null {
  const words = `${id} ${name}`.toLowerCase().split(SPLIT);
  const has = (set: ReadonlySet<string>): boolean =>
    words.some((w) => set.has(w));
  if (has(DRUM_WORDS)) {
    return "drums";
  }
  if (has(BASS_WORDS)) {
    return "bass";
  }
  if (has(LEAD_WORDS)) {
    return "lead";
  }
  return has(HARMONY_WORDS) ? "harmony" : null;
}

/** The sample generators that make drums, in the order the kit is listed. */
export const DRUM_GENERATORS = [
  "kick",
  "snare",
  "hat",
  "tom",
  "clap",
  "crash",
] as const;
export type DrumGenerator = (typeof DRUM_GENERATORS)[number];

/** The note a drum hit plays on a pitched drum channel (noise period, SID noise, FM voice): low is a thud, high a hiss. */
const KIT_NOTE: Record<DrumGenerator, number> = {
  clap: 39,
  crash: 49,
  hat: 42,
  kick: 36,
  snare: 38,
  tom: 45,
};

/** The drum as the MIDI importer's drum table has it (its generator, pitch and priority). */
export function drumVoiceOf(generator: DrumGenerator): DrumVoice {
  return drumVoice(KIT_NOTE[generator]);
}

export function drumPitch(generator: DrumGenerator): number {
  return drumVoiceOf(generator).pitch;
}

/** The drums a pitch can mean when the source does not say (a noise channel): the nearest of kick, snare, hat, crash. */
const BY_PITCH: readonly DrumGenerator[] = ["kick", "snare", "hat", "crash"];

export function drumByPitch(note: number): DrumGenerator {
  let best: DrumGenerator = "kick";
  let bestDist = Number.POSITIVE_INFINITY;
  for (const generator of BY_PITCH) {
    const dist = Math.abs(drumPitch(generator) - note);
    if (dist < bestDist) {
      bestDist = dist;
      best = generator;
    }
  }
  return best;
}

/** The drum a sample instrument plays, or null when it is not a drum sample. */
export function sampleDrum(inst: Instrument | undefined): DrumGenerator | null {
  const generator = inst?.sample?.generator;
  return (DRUM_GENERATORS as readonly string[]).includes(generator ?? "")
    ? (generator as DrumGenerator)
    : null;
}

/** True when the instrument plays drums: a noise voice, a drum sample, a SID voice on the noise waveform, or one the name says. */
export function isDrumInstrument(
  id: string,
  inst: Instrument | undefined
): boolean {
  if (!inst) {
    return roleHint(id, "") === "drums";
  }
  const noiseOnly =
    inst.sid?.waveforms.length === 1 && inst.sid.waveforms[0] === "noise";
  return (
    inst.kind === "noise" ||
    noiseOnly ||
    sampleDrum(inst) !== null ||
    roleHint(id, inst.name) === "drums"
  );
}
