/* Shared helpers for the core engine tests (the tools tests have their own in tools/helpers.ts). */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  EngineEvent,
  Instrument,
  Pattern,
  Sfx,
  Song,
  Synth,
} from "../src/index.ts";
import {
  normalizeInstrument,
  normalizeSfx,
  normalizeSong,
} from "../src/index.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

export function fixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, "utf8"));
}

export function fixtureSfx(name = "sfx-coin.json"): Sfx {
  return normalizeSfx(fixtureJson(name)).value;
}

export function fixtureInstruments(): Record<string, Instrument> {
  const ids = {
    bass: "instrument-bass.json",
    drums: "instrument-drums.json",
    lead: "instrument-lead.json",
  };
  const out: Record<string, Instrument> = {};
  for (const [id, file] of Object.entries(ids)) {
    out[id] = normalizeInstrument(fixtureJson(file)).value;
  }
  return out;
}

export function fixtureSong(): {
  song: Song;
  instruments: Record<string, Instrument>;
} {
  const instruments = fixtureInstruments();
  return {
    instruments,
    song: normalizeSong(fixtureJson("song-title.json"), instruments).value,
  };
}

export interface Demo {
  instruments: Record<string, Instrument>;
  sfx: Sfx;
  song: Song;
}

/** One of the per-chip demo fixtures (demo-gameboy.json and so on), normalized. */
export function fixtureDemo(chip: string): Demo {
  const raw = fixtureJson(`demo-${chip}.json`) as {
    song: unknown;
    instruments: Record<string, unknown>;
    sfx: unknown;
  };
  const instruments: Record<string, Instrument> = {};
  for (const [id, inst] of Object.entries(raw.instruments)) {
    instruments[id] = normalizeInstrument(inst).value;
  }
  return {
    instruments,
    sfx: normalizeSfx(raw.sfx).value,
    song: normalizeSong(raw.song, instruments).value,
  };
}

/**
 * A song cut down to the first `rows` rows of its first pattern, looping back to itself (or playing once, as the
 * original does). Rendering a whole fixture song is seconds of DSP; a test that is
 * about the engine's behavior rather than that particular music renders this instead.
 */
export function cutSong(song: Song, rows = 16): Song {
  const first = song.order[0] as string;
  const pattern = song.patterns[first] as Pattern;
  const tracks: Pattern["tracks"] = {};
  for (const [id, cells] of Object.entries(pattern.tracks)) {
    tracks[id] = cells.filter((cell) => cell.row < rows);
  }
  return {
    ...song,
    loop: song.loop === null ? null : 0,
    order: [first],
    patterns: { [first]: { length: rows, tracks } },
  };
}

/** The title song, cut to `rows` rows (see `cutSong`). */
export function fixtureShortSong(rows = 16): {
  song: Song;
  instruments: Record<string, Instrument>;
} {
  const { song, instruments } = fixtureSong();
  return { instruments, song: cutSong(song, rows) };
}

/** A chip's demo, with its song cut to `rows` rows (see `cutSong`). */
export function fixtureShortDemo(chip: string, rows = 16): Demo {
  const demo = fixtureDemo(chip);
  return { ...demo, song: cutSong(demo.song, rows) };
}

export interface Captured {
  events: EngineEvent[];
  left: Float32Array;
  right: Float32Array;
}

/** Run a synth for the given frames in blocks of blockSize, collecting copies of the events. */
export function runSynth(
  synth: Synth,
  frames: number,
  blockSize = 128
): Captured {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const events: EngineEvent[] = [];
  const bl = new Float32Array(blockSize);
  const br = new Float32Array(blockSize);
  const out: EngineEvent[] = [];
  for (let done = 0; done < frames; done += blockSize) {
    const n = Math.min(blockSize, frames - done);
    synth.process(bl, br, n, out);
    left.set(bl.subarray(0, n), done);
    right.set(br.subarray(0, n), done);
    for (const e of out) {
      events.push({ ...e });
    }
    out.length = 0;
  }
  return { events, left, right };
}

/** FNV-1a over the raw bytes of Float32 channels. */
export function hashChannels(channels: readonly Float32Array[]): string {
  let h = 0x81_1c_9d_c5;
  for (const ch of channels) {
    const bytes = new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength);
    for (let i = 0; i < bytes.length; i += 1) {
      h ^= bytes[i] ?? 0;
      h = Math.imul(h, 0x01_00_01_93);
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function peak(channels: readonly Float32Array[]): number {
  let m = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i += 1) {
      const a = Math.abs(ch[i] ?? 0);
      if (a > m) {
        m = a;
      }
    }
  }
  return m;
}

export function rms(buf: Float32Array, from = 0, to = buf.length): number {
  let s = 0;
  for (let i = from; i < to; i += 1) {
    const v = buf[i] ?? 0;
    s += v * v;
  }
  return Math.sqrt(s / Math.max(1, to - from));
}

export function toDb(x: number): number {
  return 20 * Math.log10(Math.max(x, 1e-12));
}

/** Reorder the samples by bit-reversed index, the first step of the in place FFT. */
function bitReverse(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i] ?? 0;
      re[i] = re[j] ?? 0;
      re[j] = tr;
      const ti = im[i] ?? 0;
      im[i] = im[j] ?? 0;
      im[j] = ti;
    }
  }
}

/** In place radix-2 complex FFT (re, im lengths are a power of two). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  bitReverse(re, im);
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const a = i + k;
        const b = a + len / 2;
        const xr = (re[b] ?? 0) * cr - (im[b] ?? 0) * ci;
        const xi = (re[b] ?? 0) * ci + (im[b] ?? 0) * cr;
        re[b] = (re[a] ?? 0) - xr;
        im[b] = (im[a] ?? 0) - xi;
        re[a] = (re[a] ?? 0) + xr;
        im[a] = (im[a] ?? 0) + xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Magnitude spectrum of a Hann windowed segment, zero padded to a power of two. */
function spectrum(
  buf: Float32Array,
  from: number,
  length: number,
  pad = 4
): Float64Array {
  let n = 1;
  while (n < length * pad) {
    n <<= 1;
  }
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < length; i += 1) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
    re[i] = (buf[from + i] ?? 0) * w;
  }
  fft(re, im);
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < mag.length; i += 1) {
    const r = re[i] ?? 0;
    const q = im[i] ?? 0;
    mag[i] = Math.sqrt(r * r + q * q);
  }
  return mag;
}

/** Frequency of the strongest spectral peak, with parabolic interpolation. */
export function fftPeakHz(
  buf: Float32Array,
  sampleRate: number,
  from = 0,
  length = buf.length - from
): number {
  const mag = spectrum(buf, from, length);
  let k = 1;
  for (let i = 2; i < mag.length - 1; i += 1) {
    if ((mag[i] ?? 0) > (mag[k] ?? 0)) {
      k = i;
    }
  }
  const a = Math.log((mag[k - 1] ?? 0) + 1e-20);
  const b = Math.log((mag[k] ?? 0) + 1e-20);
  const c = Math.log((mag[k + 1] ?? 0) + 1e-20);
  const off = (0.5 * (a - c)) / (a - 2 * b + c);
  return ((k + off) * sampleRate) / (mag.length * 2);
}

/** Energy (sum of squared magnitudes) between two frequencies. */
export function bandEnergy(
  buf: Float32Array,
  sampleRate: number,
  lo: number,
  hi: number,
  from = 0,
  length = buf.length - from
): number {
  const mag = spectrum(buf, from, length);
  const binHz = sampleRate / (mag.length * 2);
  let e = 0;
  for (
    let i = Math.max(1, Math.floor(lo / binHz));
    i < Math.min(mag.length, Math.ceil(hi / binHz));
    i += 1
  ) {
    e += (mag[i] ?? 0) ** 2;
  }
  return e;
}

/** Frequency from rising zero crossings over the whole buffer. */
export function zeroCrossingHz(buf: Float32Array, sampleRate: number): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = 1; i < buf.length; i += 1) {
    if ((buf[i - 1] ?? 0) < 0 && (buf[i] ?? 0) >= 0) {
      if (first < 0) {
        first = i;
      }
      last = i;
      count += 1;
    }
  }
  return count > 1 ? ((count - 1) * sampleRate) / (last - first) : 0;
}
