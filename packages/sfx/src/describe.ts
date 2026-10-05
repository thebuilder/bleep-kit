/* describeSfx: a precise paragraph for a reader who cannot hear. It states the wave, the length, the pitch path in note
   names and Hz, the sweep direction, the envelope shape and every effect that is switched on. */
import {
  type ChipId,
  hzToNote,
  noteName,
  type Sfx,
  type SfxWave,
} from "@bleepkit/core";
import {
  cutoffTime,
  octavesAt,
  pitchAt,
  pitchWindow,
  playedDuration,
} from "./pitch.ts";

const CHIP_LABELS: Readonly<Record<ChipId, string>> = {
  adlib: "the AdLib (OPL2 FM)",
  c64: "the C64 (SID)",
  custom: "the unconstrained custom chip",
  gameboy: "the Game Boy",
  genesis: "the Genesis (YM2612 FM and PSG)",
  nes: "the NES",
  snes: "the SNES (16-bit samples)",
};

const RISING = 0.25;
const VOWEL_START = /^[aeiou]/i;

function hzText(hz: number): string {
  if (hz < 100) {
    return `${(Math.round(hz * 10) / 10).toString()} Hz`;
  }
  return `${Math.round(hz).toString()} Hz`;
}

function pitchText(hz: number, tonal: boolean): string {
  return tonal ? `${noteName(hzToNote(hz))} (${hzText(hz)})` : hzText(hz);
}

function ms(seconds: number): string {
  return `${Math.round(seconds * 1000).toString()} ms`;
}

function sec(seconds: number): string {
  return `${(Math.round(seconds * 100) / 100).toString()} s`;
}

function pct(v: number): string {
  return `${num(v * 100, 1)}%`;
}

function octaves(v: number, digits = 2): string {
  const text = num(v, digits);
  return `${text} ${text === "1" ? "octave" : "octaves"}`;
}

function num(v: number, digits = 2): string {
  return (Math.round(v * 10 ** digits) / 10 ** digits).toString();
}

function lengthWord(seconds: number): string {
  if (seconds < 0.08) {
    return "very short";
  }
  if (seconds < 0.22) {
    return "short";
  }
  if (seconds < 0.7) {
    return "medium-length";
  }
  if (seconds < 1.4) {
    return "long";
  }
  return "very long";
}

/** How long one pass of the pitch path lasts: the sound, or one repeat period, or until the pitch floor stops it. */
function playedWindow(sfx: Sfx): number {
  return Math.min(playedDuration(sfx), pitchWindow(sfx));
}

function travelledOctaves(sfx: Sfx): number {
  return octavesAt(sfx.frequency, playedWindow(sfx));
}

function directionWord(sfx: Sfx): string {
  const oct = travelledOctaves(sfx);
  if (oct > RISING) {
    return "rising";
  }
  if (oct < -RISING) {
    return "falling";
  }
  return "steady";
}

function waveWord(sfx: Sfx): string {
  switch (sfx.wave) {
    case "square":
      return "square";
    case "noise":
      return sfx.noise.mode === "short" ? "metallic noise" : "noise";
    case "wave":
      return "wavetable";
    case "fm":
      return "FM";
    default:
      return sfx.wave;
  }
}

function headline(sfx: Sfx): string {
  const length = lengthWord(playedDuration(sfx));
  const flavor: string[] = [];
  const dir = directionWord(sfx);
  if (dir !== "steady") {
    flavor.push(dir);
  }
  if (sfx.arpeggio.steps.length > 0 && sfx.arpeggio.rate > 0) {
    flavor.push("arpeggiated");
  }
  if (sfx.vibrato.depth >= 0.5 && sfx.vibrato.rate > 0) {
    flavor.push("wobbling");
  }
  const words = [length, ...flavor, waveWord(sfx)].join(" ");
  const article = VOWEL_START.test(words) ? "An" : "A";
  return `${article} ${words} ${sfx.category} sound for ${CHIP_LABELS[sfx.chip]}, ${sec(playedDuration(sfx))} long.`;
}

function pulseDetail(sfx: Sfx): string {
  const sweep =
    sfx.duty.sweep === 0 ? "" : `, sweeping ${num(sfx.duty.sweep)} per second`;
  return `Pulse wave with duty ${pct(sfx.duty.start)}${sweep}.`;
}

function noiseDetail(sfx: Sfx): string {
  return sfx.noise.mode === "short"
    ? "Noise in short mode: a tonal, metallic buzz (the chip's short LFSR)."
    : "Noise in long mode: broadband hiss that reads as a rumble at low rates.";
}

function fmDetail(sfx: Sfx): string {
  const { fm } = sfx;
  if (!fm) {
    return "Two-operator FM.";
  }
  const decay =
    fm.indexDecay > 0
      ? ` decaying over ${sec(fm.indexDecay)} so the timbre mellows`
      : " held constant";
  return `Two-operator FM, modulator ratio ${num(fm.ratio)}, index ${num(fm.index)}${decay}.`;
}

const WAVE_DETAIL: Partial<Record<SfxWave, (sfx: Sfx) => string>> = {
  fm: fmDetail,
  noise: noiseDetail,
  square: pulseDetail,
  wave: (sfx) =>
    `Wavetable voice (32 steps, 4-bit), table: ${(sfx.table ?? []).join(" ")}.`,
};

function waveDetail(sfx: Sfx): string {
  const detail = WAVE_DETAIL[sfx.wave];
  return detail
    ? detail(sfx)
    : `${sfx.wave.charAt(0).toUpperCase()}${sfx.wave.slice(1)} wave.`;
}

function slideDetail(sfx: Sfx): string {
  const f = sfx.frequency;
  const parts: string[] = [];
  if (f.slide !== 0) {
    parts.push(
      `${f.slide > 0 ? "up" : "down"} ${octaves(Math.abs(f.slide))} per second`
    );
  }
  if (f.deltaSlide !== 0) {
    const speeding =
      Math.sign(f.deltaSlide) === Math.sign(f.slide || f.deltaSlide);
    parts.push(
      `${speeding ? "accelerating" : "easing off"} at ${octaves(Math.abs(f.deltaSlide))} per second squared`
    );
  }
  return parts.join(", ");
}

function pitchDetail(sfx: Sfx): string {
  const tonal = sfx.wave !== "noise";
  const label = tonal ? "Pitch" : "Noise rate";
  const f = sfx.frequency;
  const played = playedWindow(sfx);
  const end = pitchAt(f, played);
  const startText = pitchText(f.start, tonal);
  if (f.slide === 0 && f.deltaSlide === 0) {
    return `${label} holds at ${startText}.`;
  }
  const oct = Math.abs(octavesAt(f, played));
  const dir = octavesAt(f, played) >= 0 ? "up" : "down";
  const text = `${label} starts at ${startText} and slides ${dir} ${octaves(oct, 1)} to ${pitchText(end, tonal)} by the end${sfx.repeat.rate > 0 ? " of each repeat" : ""} (${slideDetail(sfx)}).`;
  const stop = cutoffTime(f, pitchWindow(sfx));
  if (f.min > 0 && Number.isFinite(stop)) {
    return `${text} The sound stops early at ${sec(stop)}, when the pitch falls below ${hzText(f.min)}.`;
  }
  return text;
}

function arpPitch(hz: number, tonal: boolean): string {
  return tonal ? `${noteName(hzToNote(hz))}, ${hzText(hz)}` : hzText(hz);
}

function arpeggioDetail(sfx: Sfx): string {
  const { steps, rate } = sfx.arpeggio;
  if (steps.length === 0 || rate <= 0) {
    return "";
  }
  const tonal = sfx.wave !== "noise";
  const base = sfx.frequency.start;
  const named = steps
    .map(
      (s) =>
        `${s > 0 ? "+" : ""}${s.toString()} (${arpPitch(base * 2 ** (s / 12), tonal)})`
    )
    .join(", ");
  return `Arpeggio cycles through the base pitch and then the steps ${named} semitones, one step every ${ms(1 / rate)} (${num(rate, 1)} steps per second).`;
}

function envelopeShape(sfx: Sfx): string {
  const { attack, sustain, decay } = sfx.envelope;
  if (attack > 0.08) {
    return "swells in, then fades";
  }
  if (sustain < 0.03 && decay > 0.05) {
    return "plucked: it starts at full level and fades straight away";
  }
  if (sustain >= decay) {
    return "holds its level, then drops away at the end";
  }
  return "starts at full level, holds briefly, then fades";
}

function envelopeDetail(sfx: Sfx): string {
  const { attack, sustain, decay, punch } = sfx.envelope;
  const attackText = attack === 0 ? "instant attack" : `attack ${ms(attack)}`;
  const punchText =
    punch > 0 && sustain > 0
      ? `, punch ${pct(punch)} extra level at the start of sustain`
      : "";
  return `Envelope: ${attackText}, sustain ${ms(sustain)}${punchText}, decay ${ms(decay)}; shape: ${envelopeShape(sfx)}.`;
}

function modulationDetail(sfx: Sfx): string[] {
  const out: string[] = [];
  if (sfx.vibrato.depth > 0 && sfx.vibrato.rate > 0) {
    out.push(
      `Vibrato of ${num(sfx.vibrato.depth)} semitones at ${num(sfx.vibrato.rate, 1)} Hz.`
    );
  }
  if (sfx.repeat.rate > 0) {
    out.push(
      `Repeats: the envelope and pitch restart every ${ms(1 / sfx.repeat.rate)} (${num(sfx.repeat.rate, 1)} Hz).`
    );
  }
  if (sfx.phaser.offset !== 0 || sfx.phaser.sweep !== 0) {
    out.push(
      `Phaser comb at ${num(sfx.phaser.offset, 1)} ms offset, sweeping ${num(sfx.phaser.sweep, 1)} ms per second (a shimmer).`
    );
  }
  return out;
}

function sweepText(sweep: number): string {
  if (sweep === 0) {
    return "fixed";
  }
  return `sweeping ${sweep > 0 ? "up" : "down"} ${octaves(Math.abs(sweep))} per second`;
}

function bitcrushDetail(sfx: Sfx): string[] {
  const { bits, rateDivide } = sfx.bitcrush;
  if (bits === null && rateDivide <= 1) {
    return [];
  }
  const depth = bits === null ? "full depth" : `${bits.toString()}-bit`;
  return [
    `Bitcrush: ${depth}, sample rate divided by ${rateDivide.toString()}.`,
  ];
}

function filterDetail(sfx: Sfx): string[] {
  const f = sfx.filter;
  const out: string[] = [];
  if (f.lowpass !== null) {
    out.push(
      `Lowpass filter at ${hzText(f.lowpass)}, ${sweepText(f.lowpassSweep)}, resonance ${pct(f.resonance)}.`
    );
  }
  if (f.highpass !== null) {
    out.push(
      `Highpass filter at ${hzText(f.highpass)}, ${sweepText(f.highpassSweep)}.`
    );
  }
  return [...out, ...bitcrushDetail(sfx)];
}

/** One paragraph describing the sound for an agent that cannot hear it. */
export function describeSfx(sfx: Sfx): string {
  const parts = [
    headline(sfx),
    waveDetail(sfx),
    pitchDetail(sfx),
    arpeggioDetail(sfx),
    envelopeDetail(sfx),
    ...modulationDetail(sfx),
    ...filterDetail(sfx),
    `Volume ${pct(sfx.volume)}.`,
  ];
  return parts.filter((p) => p.length > 0).join(" ");
}
