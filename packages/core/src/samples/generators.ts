/* The fourteen sample generators (section 3.7). Each synthesizes a GeneratedSample deterministically from its params
   and a seed. Tonal generators are tuned to C-4 (MIDI 60) and loop seamlessly: the loop body holds a whole number of
   cycles of every partial, so the loop point never clicks. */

import { mulberry32 } from "../prng.ts";
import type { GeneratedSample, SampleGeneratorId } from "../types.ts";
import { SAMPLE_SPECS } from "./specs.ts";

const TWO_PI = 2 * Math.PI;
const BASE_NOTE = 60;
const BASE_HZ = 440 * 2 ** ((BASE_NOTE - 69) / 12);
const MAX_SECONDS = 4;

type Rng = () => number;
type Params = Record<string, number>;

function param(gen: SampleGeneratorId, params: Params, key: string): number {
  const spec = SAMPLE_SPECS[gen].params[key];
  const v = params[key];
  if (!spec) {
    return v ?? 0;
  }
  const raw = v ?? spec.default;
  return Math.min(spec.max, Math.max(spec.min, raw));
}

function noise(rng: Rng): number {
  return rng() * 2 - 1;
}

/** Drum one shots are normalized hot: they are short, so their peak is nearly all the loudness they have. */
const DRUM_PEAK = 0.95;

/** Peak normalize to the given level. */
function normalize(buf: Float32Array, peak: number): void {
  let m = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const a = Math.abs(buf[i] ?? 0);
    if (a > m) {
      m = a;
    }
  }
  if (m > 1e-9) {
    const g = peak / m;
    for (let i = 0; i < buf.length; i += 1) {
      buf[i] = (buf[i] ?? 0) * g;
    }
  }
}

/** Ramp the first `seconds` up from silence so the sound does not click. */
function fadeIn(buf: Float32Array, sr: number, seconds: number): void {
  const n = Math.round(seconds * sr);
  for (let i = 0; i < n; i += 1) {
    buf[i] = (buf[i] ?? 0) * (i / n);
  }
}

/** One sample of the metallic cluster: the METAL square oscillators advance by `scale` and add up (not yet divided). */
function metalSum(phases: Float64Array, scale: number, sr: number): number {
  let s = 0;
  for (let k = 0; k < METAL.length; k += 1) {
    phases[k] = ((phases[k] ?? 0) + ((METAL[k] ?? 0) * scale) / sr) % 1;
    s += (phases[k] ?? 0) < 0.5 ? 1 : -1;
  }
  return s;
}

/** Fade the last ms to zero so one-shots never end on a step. */
function fadeEnd(buf: Float32Array, sr: number, seconds = 0.004): void {
  const n = Math.min(buf.length, Math.max(1, Math.round(seconds * sr)));
  for (let i = 0; i < n; i += 1) {
    const idx = buf.length - 1 - i;
    buf[idx] = (buf[idx] ?? 0) * (i / n);
  }
}

type FilterKind = "lp" | "hp" | "bp";

/** Zero delay feedback state variable filter, in place. */
function svf(
  buf: Float32Array,
  kind: FilterKind,
  hz: number,
  q: number,
  sr: number
): void {
  const g = Math.tan((Math.PI * Math.min(hz, sr * 0.45)) / sr);
  const k = 1 / Math.max(0.3, q);
  const a1 = 1 / (1 + g * (g + k));
  const a2 = g * a1;
  const a3 = g * a2;
  let ic1 = 0;
  let ic2 = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const v0 = buf[i] ?? 0;
    const v3 = v0 - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    buf[i] = kind === "lp" ? v2 : kind === "bp" ? v1 : v0 - k * v1 - v2;
  }
}

function frames(seconds: number, sr: number): number {
  return Math.max(
    16,
    Math.min(Math.round(seconds * sr), Math.round(MAX_SECONDS * sr))
  );
}

function oneShot(data: Float32Array, sr: number): GeneratedSample {
  return {
    baseNote: BASE_NOTE,
    data,
    loopEnd: null,
    loopStart: null,
    sampleRate: sr,
  };
}

/** Choose a loop length of whole cycles for a base frequency: returns the number of samples N and the exact cycle
    count K, such that sr * K / N is within a fraction of a cent of hz. K is a multiple of `multiple`. */
function loopShape(
  hz: number,
  sr: number,
  minSeconds: number,
  multiple = 1
): { n: number; k: number; f: number } {
  const p = sr / hz;
  let k = Math.max(
    multiple,
    Math.ceil((minSeconds * hz) / multiple) * multiple
  );
  let best = {
    err: Number.POSITIVE_INFINITY,
    f: (sr * k) / Math.round(k * p),
    k,
    n: Math.round(k * p),
  };
  for (let tries = 0; tries < 40; tries += 1) {
    const n = Math.round(k * p);
    const err = Math.abs(n - k * p) / (k * p);
    if (err < best.err) {
      best = { err, f: (sr * k) / n, k, n };
    }
    k += multiple;
  }
  return { f: best.f, k: best.k, n: best.n };
}

// ------------------------------------------------------------------ drums

function kick(p: Params, seed: number, sr: number): GeneratedSample {
  const g: SampleGeneratorId = "kick";
  const pitch = param(g, p, "pitch");
  const sweep = param(g, p, "sweep");
  const decay = param(g, p, "decay");
  const click = param(g, p, "click");
  const drive = param(g, p, "drive");
  const rng = mulberry32(seed);
  const n = frames(decay * 1.3 + 0.05, sr);
  const out = new Float32Array(n);
  const startHz = pitch * (1 + sweep * 7);
  const sweepTau = 0.012 + 0.03 * sweep;
  const ampTau = decay / 4.6;
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    const f = pitch + (startHz - pitch) * Math.exp(-t / sweepTau);
    phase += f / sr;
    let v = Math.sin(TWO_PI * phase) * Math.exp(-t / ampTau);
    if (t < 0.004) {
      v += noise(rng) * click * (1 - t / 0.004) * 0.8;
    }
    out[i] = v;
  }
  if (drive > 0) {
    const d = 1 + drive * 5;
    for (let i = 0; i < n; i += 1) {
      out[i] = Math.tanh((out[i] ?? 0) * d);
    }
  }
  fadeEnd(out, sr);
  normalize(out, DRUM_PEAK);
  return oneShot(out, sr);
}

function snare(p: Params, seed: number, sr: number): GeneratedSample {
  const g: SampleGeneratorId = "snare";
  const tone = param(g, p, "tone");
  const noiseAmt = param(g, p, "noise");
  const decay = param(g, p, "decay");
  const snap = param(g, p, "snap");
  const rng = mulberry32(seed);
  const n = frames(decay * 1.4 + 0.03, sr);
  const body = new Float32Array(n);
  const hiss = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    phase += (tone * (1 + 0.6 * Math.exp(-t / 0.02))) / sr;
    body[i] = Math.sin(TWO_PI * phase) * Math.exp(-t / (decay * 0.28));
    const burst = 1 + snap * 2.5 * Math.exp(-t / 0.006);
    hiss[i] = noise(rng) * Math.exp(-t / (decay * 0.42)) * burst;
  }
  svf(hiss, "hp", 1400, 0.8, sr);
  svf(hiss, "lp", 9000, 0.7, sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] =
      (body[i] ?? 0) * (1 - noiseAmt * 0.5) + (hiss[i] ?? 0) * noiseAmt * 1.2;
  }
  fadeEnd(out, sr);
  normalize(out, DRUM_PEAK);
  return oneShot(out, sr);
}

const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800] as const;

function hat(p: Params, seed: number, sr: number): GeneratedSample {
  const g: SampleGeneratorId = "hat";
  const decay = param(g, p, "decay");
  const tone = param(g, p, "tone");
  const open = param(g, p, "open");
  const rng = mulberry32(seed);
  const len = decay + open * 0.45;
  const n = frames(len * 1.2 + 0.02, sr);
  const out = new Float32Array(n);
  const phases = new Float64Array(METAL.length);
  const scale = 3 + tone * 3;
  for (let i = 0; i < n; i += 1) {
    const s = metalSum(phases, scale, sr);
    const t = i / sr;
    out[i] = (s / METAL.length + noise(rng) * 0.5) * Math.exp(-t / (len / 4.6));
  }
  svf(out, "hp", 5000 + tone * 3000, 0.9, sr);
  fadeEnd(out, sr);
  normalize(out, DRUM_PEAK);
  return oneShot(out, sr);
}

function tom(p: Params, _seed: number, sr: number): GeneratedSample {
  const g: SampleGeneratorId = "tom";
  const pitch = param(g, p, "pitch");
  const decay = param(g, p, "decay");
  const sweep = param(g, p, "sweep");
  const n = frames(decay * 1.3 + 0.05, sr);
  const out = new Float32Array(n);
  const startHz = pitch * (1 + sweep * 2.2);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    phase += (pitch + (startHz - pitch) * Math.exp(-t / 0.035)) / sr;
    out[i] =
      Math.sin(TWO_PI * phase) * Math.exp(-t / (decay / 4.6)) +
      0.12 * Math.sin(TWO_PI * phase * 2.3) * Math.exp(-t / 0.04);
  }
  fadeEnd(out, sr);
  normalize(out, DRUM_PEAK);
  return oneShot(out, sr);
}

function clap(p: Params, seed: number, sr: number): GeneratedSample {
  const g: SampleGeneratorId = "clap";
  const decay = param(g, p, "decay");
  const spread = param(g, p, "spread");
  const tone = param(g, p, "tone");
  const rng = mulberry32(seed);
  const gap = 0.007 + spread * 0.012;
  const n = frames(gap * 3 + decay * 1.3 + 0.02, sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    let env = 0;
    for (let b = 0; b < 3; b += 1) {
      const dt = t - b * gap;
      if (dt >= 0) {
        env += Math.exp(-dt / 0.0045) * (b === 2 ? 0.6 : 1);
      }
    }
    const tail = t >= gap * 3 ? Math.exp(-(t - gap * 3) / (decay / 4.6)) : 0;
    out[i] = noise(rng) * (env * 0.8 + tail);
  }
  svf(out, "bp", 900 + tone * 1800, 1.2, sr);
  fadeEnd(out, sr);
  normalize(out, DRUM_PEAK);
  return oneShot(out, sr);
}

function crash(p: Params, seed: number, sr: number): GeneratedSample {
  const g: SampleGeneratorId = "crash";
  const decay = param(g, p, "decay");
  const tone = param(g, p, "tone");
  const rng = mulberry32(seed);
  const n = frames(decay * 1.1, sr);
  const out = new Float32Array(n);
  const phases = new Float64Array(METAL.length);
  for (let i = 0; i < n; i += 1) {
    const s = metalSum(phases, 2.7, sr);
    const t = i / sr;
    const env = Math.exp(-t / (decay / 4.6)) * (1 + 1.5 * Math.exp(-t / 0.03));
    out[i] = (noise(rng) * 0.8 + (s / METAL.length) * 0.4) * env;
  }
  svf(out, "hp", 2500 + tone * 2500, 0.7, sr);
  fadeEnd(out, sr, 0.01);
  normalize(out, DRUM_PEAK);
  return oneShot(out, sr);
}

// ------------------------------------------------------------------ tonal

/** Karplus-Strong string with linear interpolated fractional delay. */
function pluck(p: Params, seed: number, sr: number): GeneratedSample {
  const g: SampleGeneratorId = "pluck";
  const brightness = param(g, p, "brightness");
  const damp = param(g, p, "damp");
  const pick = param(g, p, "pick");
  const rng = mulberry32(seed);
  const n = frames(2.2, sr);
  const out = new Float32Array(n);
  const delay = sr / BASE_HZ - 0.5;
  const len = Math.ceil(delay) + 2;
  const line = new Float32Array(len);
  // excitation: noise through a one-pole whose cutoff follows the brightness, comb filtered by pick position
  let lp = 0;
  const a = 0.08 + brightness * 0.9;
  const exc = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
    lp += a * (noise(rng) - lp);
    exc[i] = lp;
  }
  const pickDelay = Math.max(1, Math.round(pick * 0.5 * len));
  for (let i = 0; i < len; i += 1) {
    line[i] = (exc[i] ?? 0) - (exc[(i + len - pickDelay) % len] ?? 0) * 0.7;
  }
  const loss = 0.9905 + (1 - damp) * 0.0094;
  const blend = 0.5 + damp * 0.15;
  let pos = 0;
  let prev = 0;
  for (let i = 0; i < n; i += 1) {
    // read position delay samples behind the write position
    const rp = pos - delay;
    const base = Math.floor(rp);
    const frac = rp - base;
    const i0 = ((base % len) + len) % len;
    const i1 = (i0 + 1) % len;
    const y = (line[i0] ?? 0) * (1 - frac) + (line[i1] ?? 0) * frac;
    const filtered = (y * (1 - blend) + prev * blend) * loss;
    prev = y;
    line[pos % len] = filtered;
    out[i] = y;
    pos += 1;
  }
  fadeEnd(out, sr, 0.02);
  normalize(out, 0.85);
  return oneShot(out, sr);
}

function withLoop(
  data: Float32Array,
  loopStart: number,
  sr: number
): GeneratedSample {
  return {
    baseNote: BASE_NOTE,
    data,
    loopEnd: data.length,
    loopStart,
    sampleRate: sr,
  };
}

/** Run a filter over the body so it is in steady state, then keep only the last `body` samples. */
function steadyBody(
  make: (total: number) => Float32Array,
  body: number,
  preroll: number
): Float32Array {
  const full = make(body + preroll);
  return full.slice(preroll);
}

function bass(p: Params, _seed: number, sr: number): GeneratedSample {
  const g: SampleGeneratorId = "bass";
  const cutoff = param(g, p, "cutoff");
  const resonance = param(g, p, "resonance");
  const sub = param(g, p, "sub");
  const shape = loopShape(BASE_HZ / 2, sr, 0.5, 2);
  const body = shape.n;
  const f = shape.f;
  const pre = Math.round(sr * 0.2);
  const data = steadyBody(
    (total) => {
      const buf = new Float32Array(total);
      for (let i = 0; i < total; i += 1) {
        const ph = ((i - pre) * f * 2) / sr;
        const phase = ph - Math.floor(ph);
        buf[i] = (2 * phase - 1) * 0.8 + Math.sin(TWO_PI * ph * 0.5) * sub;
      }
      svf(buf, "lp", 120 + cutoff * cutoff * 4500, 0.7 + resonance * 6, sr);
      return buf;
    },
    body,
    pre
  );
  // the bass loop has a short attack from the first period of silence-free body: keep it all as loop
  normalize(data, 0.8);
  return withLoop(data, 0, sr);
}

function pad(p: Params, _seed: number, sr: number): GeneratedSample {
  const g: SampleGeneratorId = "pad";
  const detune = param(g, p, "detune");
  const cutoff = param(g, p, "cutoff");
  const speed = param(g, p, "speed");
  const shape = loopShape(BASE_HZ, sr, 1.6);
  const body = shape.n;
  const spread = [-1, -0.37, 0.21, 0.62, 1];
  const pre = body;
  const data = new Float32Array(body);
  const buf = new Float32Array(body * 2);
  // partial frequencies are whole cycles per loop so the body is exactly periodic
  for (let k = 0; k < spread.length; k += 1) {
    const ratio = 1 + (spread[k] ?? 0) * detune * 0.012;
    const cycles = Math.max(1, Math.round(shape.k * ratio));
    for (let i = 0; i < buf.length; i += 1) {
      const ph = (cycles * i) / body + k * 0.19;
      buf[i] = (buf[i] ?? 0) + (2 * (ph - Math.floor(ph)) - 1) * 0.25;
    }
  }
  // slow filter motion: one filter sweep per loop, applied block-wise with a one-pole whose cutoff follows an LFO
  const base = 250 + cutoff * 5000;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const lfo =
      0.5 +
      0.5 *
        Math.sin(
          TWO_PI * (i / body) * Math.max(1, Math.round(speed * 3)) + 0.7
        );
    const fc = base * (0.45 + 0.55 * (1 - speed * 0.7 + speed * 0.7 * lfo));
    const a = 1 - Math.exp((-TWO_PI * fc) / sr);
    y1 += a * ((buf[i] ?? 0) - y1);
    y2 += a * (y1 - y2);
    if (i >= pre) {
      data[i - pre] = y2;
    }
  }
  normalize(data, 0.75);
  return withLoop(data, 0, sr);
}

function organ(p: Params, _seed: number, sr: number): GeneratedSample {
  const g: SampleGeneratorId = "organ";
  const sub = param(g, p, "sub");
  const second = param(g, p, "second");
  const third = param(g, p, "third");
  const fourth = param(g, p, "fourth");
  const perc = param(g, p, "perc");
  const shape = loopShape(BASE_HZ / 2, sr, 0.5, 2);
  const body = shape.n;
  const intro = Math.round(0.12 * sr);
  const total = intro + body;
  const out = new Float32Array(total);
  const f = shape.f * 2;
  const drawbars: [number, number][] = [
    [0.5, sub],
    [1, second],
    [2, third],
    [4, fourth],
  ];
  for (let i = 0; i < total; i += 1) {
    const t = (i - intro) / sr;
    let s = 0;
    for (const [mult, level] of drawbars) {
      s += Math.sin(TWO_PI * f * mult * t) * level;
    }
    // key click and a decaying third harmonic percussion in the intro only
    const pe = i < intro ? Math.exp(-i / sr / 0.05) : 0;
    s += Math.sin(TWO_PI * f * 3 * 0.5 * t * 2) * perc * pe * 1.5;
    out[i] = s;
  }
  // soft attack so the key does not click
  fadeIn(out, sr, 0.004);
  normalize(out, 0.7);
  return withLoop(out, intro, sr);
}

function bell(p: Params, _seed: number, sr: number): GeneratedSample {
  const g: SampleGeneratorId = "bell";
  const ratio = param(g, p, "ratio");
  const index = param(g, p, "index");
  const decay = param(g, p, "decay");
  const n = frames(decay * 1.5 + 0.1, sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    const mod =
      Math.sin(TWO_PI * BASE_HZ * ratio * t) *
      index *
      Math.exp(-t / (decay * 0.35));
    const amp = Math.exp(-t / (decay / 3.5));
    out[i] =
      Math.sin(TWO_PI * BASE_HZ * t + mod) * amp * (t < 0.002 ? t / 0.002 : 1);
  }
  fadeEnd(out, sr, 0.01);
  normalize(out, 0.85);
  return oneShot(out, sr);
}

function strings(p: Params, _seed: number, sr: number): GeneratedSample {
  const g: SampleGeneratorId = "strings";
  const detune = param(g, p, "detune");
  const bright = param(g, p, "bright");
  const attack = param(g, p, "attack");
  const shape = loopShape(BASE_HZ, sr, 1.4);
  const body = shape.n;
  const intro = Math.round((0.01 + attack * 0.35) * sr);
  const total = intro + body;
  const buf = new Float32Array(total + body);
  const voices = [-1, 0, 1, -0.5, 0.5];
  for (let k = 0; k < voices.length; k += 1) {
    const ratio = 1 + (voices[k] ?? 0) * detune * 0.01;
    const cycles = Math.max(1, Math.round(shape.k * ratio));
    for (let i = 0; i < buf.length; i += 1) {
      // slow tremolo-like chorus: a per-voice phase wobble with a whole number of cycles per loop
      const ph =
        (cycles * (i - intro)) / body +
        0.045 * Math.sin((TWO_PI * (i - intro)) / body + k);
      buf[i] = (buf[i] ?? 0) + (2 * (ph - Math.floor(ph)) - 1) * 0.22;
    }
  }
  svf(buf, "lp", 700 + bright * 6000, 0.8, sr);
  const out = buf.slice(buf.length - total);
  // the filter ran over a longer buffer, so the tail is in steady state: apply the fade-in to the intro
  for (let i = 0; i < intro; i += 1) {
    const x = i / intro;
    out[i] = (out[i] ?? 0) * x * x;
  }
  normalize(out, 0.75);
  return withLoop(out, intro, sr);
}

/** Formant frequencies of the vowels a, e, i, o, u (three each). */
const VOWEL_FORMANTS: readonly (readonly number[])[] = [
  [800, 1150, 2900],
  [400, 1700, 2600],
  [270, 2150, 2900],
  [450, 800, 2830],
  [325, 700, 2530],
];
const FORMANT_WEIGHTS = [1, 0.7, 0.35] as const;

/** Glottal-ish source: a narrow pulse train with a little vibrato whose period is the loop. */
function glottalSource(
  buf: Float32Array,
  f: number,
  start: number,
  body: number,
  sr: number
): void {
  for (let i = 0; i < buf.length; i += 1) {
    const t = (i - start) / sr;
    const ph = f * t + 0.004 * Math.sin((TWO_PI * (i - start)) / body);
    const x = ph - Math.floor(ph);
    buf[i] = x < 0.22 ? 1 - x / 0.22 : -0.2;
  }
}

/** The source through three band passes at the vowel's formants (interpolated by `vowel` 0..1), weighted and added. */
function formantMix(
  source: Float32Array,
  vowel: number,
  sr: number
): Float32Array {
  const pos = vowel * (VOWEL_FORMANTS.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(VOWEL_FORMANTS.length - 1, lo + 1);
  const fr = pos - lo;
  const mixOut = new Float32Array(source.length);
  for (let b = 0; b < 3; b += 1) {
    const hz =
      (VOWEL_FORMANTS[lo]?.[b] ?? 500) * (1 - fr) +
      (VOWEL_FORMANTS[hi]?.[b] ?? 500) * fr;
    const band = source.slice();
    svf(band, "bp", hz, 6 + b * 2, sr);
    const w = FORMANT_WEIGHTS[b] ?? 0;
    for (let i = 0; i < band.length; i += 1) {
      mixOut[i] = (mixOut[i] ?? 0) + (band[i] ?? 0) * w;
    }
  }
  return mixOut;
}

/** Add band passed noise at `amount` of the signal's peak. */
function addBreath(
  out: Float32Array,
  rng: () => number,
  amount: number,
  sr: number
): void {
  const hiss = new Float32Array(out.length);
  for (let i = 0; i < hiss.length; i += 1) {
    hiss[i] = noise(rng);
  }
  svf(hiss, "bp", 2500, 0.8, sr);
  let m = 0;
  for (let i = 0; i < out.length; i += 1) {
    m = Math.max(m, Math.abs(out[i] ?? 0));
  }
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (out[i] ?? 0) + (hiss[i] ?? 0) * amount * m * 0.25;
  }
}

function choir(p: Params, seed: number, sr: number): GeneratedSample {
  const g: SampleGeneratorId = "choir";
  const vowel = param(g, p, "vowel");
  const breath = param(g, p, "breath");
  const rng = mulberry32(seed);
  const shape = loopShape(BASE_HZ, sr, 1.2);
  const body = shape.n;
  const intro = Math.round(0.08 * sr);
  const total = intro + body;
  const pre = Math.round(sr * 0.1);
  const buf = new Float32Array(total + pre);
  glottalSource(buf, shape.f, pre + intro, body, sr);
  const out = formantMix(buf, vowel, sr).slice(pre);
  addBreath(out, rng, breath, sr);
  // crossfade the loop seam, so the breath noise does not click
  const xf = Math.min(Math.round(0.02 * sr), Math.floor(body / 4), intro);
  for (let i = 0; i < xf; i += 1) {
    const w = i / xf;
    const a = out[total - xf + i] ?? 0;
    const b = out[intro - xf + i] ?? 0;
    out[total - xf + i] = a * (1 - w) + b * w;
  }
  fadeIn(out, sr, 0.02);
  normalize(out, 0.75);
  return withLoop(out, intro, sr);
}

function lead(_p: Params, _seed: number, sr: number): GeneratedSample {
  const shape = loopShape(BASE_HZ, sr, 0.8);
  const body = shape.n;
  const intro = Math.round(0.02 * sr);
  const total = intro + body;
  const out = new Float32Array(total);
  const f = shape.f;
  let phase = 0;
  for (let i = 0; i < total; i += 1) {
    const rel = i - intro;
    // vibrato of exactly three cycles per loop body, in cycles of the carrier
    const vib = 0.0035 * Math.sin((TWO_PI * 3 * rel) / body);
    phase = (f * rel) / sr + vib + 8;
    const x = phase - Math.floor(phase);
    const width = 0.3 + 0.1 * Math.sin((TWO_PI * rel) / body);
    out[i] = x < width ? 1 : -1;
  }
  let mean = 0;
  for (let i = intro; i < total; i += 1) {
    mean += out[i] ?? 0;
  }
  mean /= body;
  for (let i = 0; i < total; i += 1) {
    out[i] = (out[i] ?? 0) - mean;
  }
  svf(out, "lp", 6000, 0.7, sr);
  fadeIn(out, sr, 0.006);
  normalize(out, 0.7);
  return withLoop(out, intro, sr);
}

const GENERATORS: Readonly<
  Record<
    SampleGeneratorId,
    (p: Params, seed: number, sr: number) => GeneratedSample
  >
> = {
  bass,
  bell,
  choir,
  clap,
  crash,
  hat,
  kick,
  lead,
  organ,
  pad,
  pluck,
  snare,
  strings,
  tom,
};

export function runGenerator(
  gen: SampleGeneratorId,
  params: Params,
  seed: number,
  sampleRate: number
): GeneratedSample {
  const fn = GENERATORS[gen];
  return fn(params, seed, sampleRate);
}
