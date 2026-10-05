import type { RenderResult } from "../types.ts";
import { mixToMono } from "./buffers.ts";
import { measureDutyCycle } from "./duty.ts";
import { ampToDb, DB_FLOOR, hzToNoteName, powerToDb, round } from "./format.ts";
import { integratedLufs } from "./loudness.ts";
import { medianPitch, trackPitch } from "./pitch.ts";
import { createSpectrumWork, windowedMagSq } from "./spectrum.ts";

export interface Analysis {
  channels: number;
  /** Frames where any channel reaches |x| >= 0.999; `first` is the frame index of the first one. */
  clipped: { frames: number; first: number | null };
  crestDb: number;
  dcOffset: number;
  /** Seconds. */
  duration: number;
  /** Share of time spent high, for a pitched two level (square or pulse) signal; null for anything else. */
  dutyCycle: number | null;
  /** RMS per step (10 ms, widened so there are at most 1000 points); `time` is where the step starts. */
  envelope: { time: number; db: number }[];
  file: string;
  frames: number;
  images?: { waveform: string; spectrogram: string; scopes?: string };
  /** Seconds under -60 dBFS at each end (both equal the duration for a silent file). */
  leadingSilence: number;
  /**
   * Seconds. seamDiffDb: RMS difference (dBFS) between the 5 ms before loopEnd and the 5 ms before loopStart; below
   * -40 dB the seam is clean. Null when the loop starts too close to the beginning of the file to compare.
   */
  loop: { start: number; end: number; seamDiffDb: number | null } | null;
  /** K-weighted integrated loudness (BS.1770, gated). */
  lufs: number;
  peakDb: number;
  pitch: {
    medianHz: number | null;
    medianNote: string | null;
    track: { time: number; hz: number | null; confidence: number }[];
  };
  rmsDb: number;
  sampleRate: number;
  /** Level of the quietest 50 ms window. */
  silenceDb: number;
  /** Bands are mean-square levels in dBFS (a full scale sine inside a band reads -3 dB). */
  spectrum: {
    centroidHz: number;
    bands: { lowDb: number; midDb: number; highDb: number };
  };
  trailingSilence: number;
}

export interface AnalyzeOptions {
  /** Name echoed into Analysis.file. */
  file?: string;
  /** Pitch entries kept (evenly thinned); default 200. Pass Infinity to keep every frame. */
  maxTrack?: number;
  /** YIN window in samples; default 2048. */
  pitchWindow?: number;
  /**
   * What produced the audio, so the duty cycle is only reported for a pulse. An sfx wave name ("square" measures the
   * duty, every other wave reports null); null when the source is not a single oscillator (a song) or is unknown
   * (a bare file). Left out, the signal itself decides: it must be a pitched two level wave.
   */
  wave?: string | null;
}

const CLIP_LEVEL = 0.999;
const SILENCE_LEVEL = 0.001;
const SILENCE_WINDOW_SECONDS = 0.05;
const SEAM_SECONDS = 0.005;
const ENVELOPE_SECONDS = 0.01;
const ENVELOPE_MAX_POINTS = 1000;
const DEFAULT_MAX_TRACK = 200;
const SPECTRUM_SIZE = 2048;
const LOW_BAND: [number, number] = [20, 250];
const MID_BAND: [number, number] = [250, 4000];

interface Levels {
  clippedFrames: number;
  firstClip: number | null;
  leading: number;
  peak: number;
  sum: number;
  sumSquares: number;
  trailing: number;
}

function measureLevels(r: RenderResult): Levels {
  const planes = r.channels;
  let peak = 0;
  let sumSquares = 0;
  let sum = 0;
  for (const plane of planes) {
    for (let i = 0; i < r.frames; i += 1) {
      const x = plane[i] ?? 0;
      sum += x;
      sumSquares += x * x;
      peak = Math.max(peak, Math.abs(x));
    }
  }
  let clippedFrames = 0;
  let firstClip: number | null = null;
  let leading = r.frames;
  let trailing = r.frames;
  for (let i = 0; i < r.frames; i += 1) {
    let frameMax = 0;
    for (const plane of planes) {
      frameMax = Math.max(frameMax, Math.abs(plane[i] ?? 0));
    }
    if (frameMax >= CLIP_LEVEL) {
      clippedFrames += 1;
      firstClip ??= i;
    }
    if (frameMax > SILENCE_LEVEL) {
      leading = Math.min(leading, i);
      trailing = r.frames - 1 - i;
    }
  }
  return { clippedFrames, firstClip, leading, peak, sum, sumSquares, trailing };
}

/** RMS level in dB of one stretch of every channel. */
function windowRmsDb(planes: Float32Array[], from: number, to: number): number {
  let sum = 0;
  for (const plane of planes) {
    for (let i = from; i < to; i += 1) {
      const x = plane[i] ?? 0;
      sum += x * x;
    }
  }
  const count = (to - from) * planes.length;
  return count > 0 ? powerToDb(sum / count) : DB_FLOOR;
}

function quietestWindowDb(r: RenderResult): number {
  const len = Math.max(1, Math.round(SILENCE_WINDOW_SECONDS * r.sampleRate));
  if (r.frames <= len) {
    return windowRmsDb(r.channels, 0, r.frames);
  }
  let quietest = Number.POSITIVE_INFINITY;
  for (let from = 0; from + len <= r.frames; from += len) {
    quietest = Math.min(quietest, windowRmsDb(r.channels, from, from + len));
  }
  return quietest;
}

function envelopeOf(r: RenderResult): { time: number; db: number }[] {
  if (r.frames === 0) {
    return [];
  }
  const step = Math.max(
    Math.round(ENVELOPE_SECONDS * r.sampleRate),
    Math.ceil(r.frames / ENVELOPE_MAX_POINTS)
  );
  const points: { time: number; db: number }[] = [];
  for (let from = 0; from < r.frames; from += step) {
    const db = windowRmsDb(r.channels, from, Math.min(r.frames, from + step));
    points.push({ db: round(db, 2), time: round(from / r.sampleRate, 4) });
  }
  return points;
}

/** Sum of squared differences between two equal-length stretches, treating positions outside the signal as zero. */
function seamSquares(
  planes: Float32Array[],
  a: number,
  b: number,
  len: number
): number {
  let sum = 0;
  for (const plane of planes) {
    for (let i = 0; i < len; i += 1) {
      const d = (plane[a + i] ?? 0) - (plane[b + i] ?? 0);
      sum += d * d;
    }
  }
  return sum;
}

function loopOf(r: RenderResult): Analysis["loop"] {
  if (
    r.loopStart === undefined ||
    r.loopEnd === undefined ||
    r.loopEnd <= r.loopStart
  ) {
    return null;
  }
  const len = Math.max(1, Math.round(SEAM_SECONDS * r.sampleRate));
  const start = r.loopStart;
  const end = r.loopEnd;
  // The 5 ms before loopEnd against the 5 ms before loopStart: when the loop is seamless the music reaches loopEnd in
  // the state it was in when it reached loopStart, so playing on from loopStart continues it. A loop that starts at
  // the very beginning of the file has nothing before its start to compare with.
  let seamDiffDb: number | null = null;
  if (start >= len && end <= r.frames) {
    const squares = seamSquares(r.channels, end - len, start - len, len);
    seamDiffDb = round(powerToDb(squares / (len * r.channels.length)), 2);
  }
  return {
    end: round(end / r.sampleRate, 4),
    seamDiffDb,
    start: round(start / r.sampleRate, 4),
  };
}

function bandPower(
  power: Float64Array,
  binHz: number,
  lo: number,
  hi: number
): number {
  let sum = 0;
  for (let k = 0; k < power.length; k += 1) {
    const f = k * binHz;
    if (f >= lo && f < hi) {
      sum += power[k] ?? 0;
    }
  }
  return sum;
}

/** Welch average of the mean-square power spectrum over all channels. */
function averagePower(r: RenderResult): Float64Array {
  const work = createSpectrumWork(SPECTRUM_SIZE);
  const { bins } = work;
  const acc = new Float64Array(bins);
  const mag = new Float64Array(bins);
  const hop = SPECTRUM_SIZE / 2;
  const frameCount =
    r.frames <= SPECTRUM_SIZE
      ? 1
      : Math.floor((r.frames - SPECTRUM_SIZE) / hop) + 1;
  for (const plane of r.channels) {
    for (let f = 0; f < frameCount; f += 1) {
      windowedMagSq(work, plane, f * hop, mag);
      for (let k = 0; k < bins; k += 1) {
        const edge = k === 0 || k === bins - 1 ? 0.5 : 1;
        acc[k] = (acc[k] ?? 0) + (mag[k] ?? 0) * work.powerScale * edge;
      }
    }
  }
  const norm = 1 / (frameCount * Math.max(1, r.channels.length));
  for (let k = 0; k < bins; k += 1) {
    acc[k] = (acc[k] ?? 0) * norm;
  }
  return acc;
}

function spectrumOf(r: RenderResult): Analysis["spectrum"] {
  const power = averagePower(r);
  const binHz = r.sampleRate / SPECTRUM_SIZE;
  let weighted = 0;
  let total = 0;
  for (let k = 0; k < power.length; k += 1) {
    weighted += k * binHz * (power[k] ?? 0);
    total += power[k] ?? 0;
  }
  const nyquist = r.sampleRate / 2 + 1;
  return {
    bands: {
      highDb: round(
        powerToDb(bandPower(power, binHz, MID_BAND[1], nyquist)),
        2
      ),
      lowDb: round(
        powerToDb(bandPower(power, binHz, LOW_BAND[0], LOW_BAND[1])),
        2
      ),
      midDb: round(
        powerToDb(bandPower(power, binHz, MID_BAND[0], MID_BAND[1])),
        2
      ),
    },
    centroidHz: total > 0 ? round(weighted / total, 1) : 0,
  };
}

function thin<T>(items: T[], max: number): T[] {
  if (items.length <= max) {
    return items;
  }
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) {
    const item = items[Math.floor((i * items.length) / max)];
    if (item !== undefined) {
      out.push(item);
    }
  }
  return out;
}

function pitchOf(
  mono: Float32Array,
  r: RenderResult,
  opts: AnalyzeOptions
): Analysis["pitch"] {
  const full = trackPitch(
    mono,
    r.sampleRate,
    opts.pitchWindow === undefined ? {} : { window: opts.pitchWindow }
  );
  const median = medianPitch(full);
  const track = thin(full, opts.maxTrack ?? DEFAULT_MAX_TRACK).map((p) => ({
    confidence: round(p.confidence, 3),
    hz: p.hz === null ? null : round(p.hz, 2),
    time: round(p.time, 4),
  }));
  return {
    medianHz: median === null ? null : round(median, 2),
    medianNote: median === null ? null : hzToNoteName(median),
    track,
  };
}

function dutyOf(mono: Float32Array, sampleRate: number): number | null {
  const duty = measureDutyCycle(mono, sampleRate);
  return duty === null ? null : round(duty, 4);
}

/** The duty cycle, for a source that can be a pulse wave and a signal that is one. */
function dutyFor(
  mono: Float32Array,
  sampleRate: number,
  wave: string | null | undefined
): number | null {
  if (wave !== undefined && wave !== "square") {
    return null;
  }
  return dutyOf(mono, sampleRate);
}

/** Measure a render: levels, loudness, clipping, silence, loop seam, spectrum, pitch, envelope and duty cycle. */
export function analyze(r: RenderResult, opts: AnalyzeOptions = {}): Analysis {
  const levels = measureLevels(r);
  const samples = Math.max(1, r.frames * r.channels.length);
  const peakDb = ampToDb(levels.peak);
  const rmsDb = powerToDb(levels.sumSquares / samples);
  const lufs = integratedLufs(r.channels, r.frames, r.sampleRate);
  const mono = mixToMono(r);
  const duration = r.frames / r.sampleRate;
  return {
    channels: r.channels.length,
    clipped: { first: levels.firstClip, frames: levels.clippedFrames },
    crestDb: round(peakDb - rmsDb, 2),
    dcOffset: round(levels.sum / samples, 6),
    duration: round(duration, 6),
    dutyCycle: dutyFor(mono, r.sampleRate, opts.wave),
    envelope: envelopeOf(r),
    file: opts.file ?? "",
    frames: r.frames,
    leadingSilence: round(levels.leading / r.sampleRate, 4),
    loop: loopOf(r),
    lufs: Number.isFinite(lufs) ? round(lufs, 2) : DB_FLOOR,
    peakDb: round(peakDb, 2),
    pitch: pitchOf(mono, r, opts),
    rmsDb: round(rmsDb, 2),
    sampleRate: r.sampleRate,
    silenceDb: round(quietestWindowDb(r), 2),
    spectrum: spectrumOf(r),
    trailingSilence: round(levels.trailing / r.sampleRate, 4),
  };
}
