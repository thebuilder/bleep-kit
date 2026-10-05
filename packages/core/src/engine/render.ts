/* Offline rendering (section 4.2): build a Synth at the requested rate, drive it with the right messages and run
   process() in 128-frame blocks, collecting events. The limiter's lookahead delay is trimmed so audio lines up with
   event frames. Pure functions of their inputs: two calls give bit-identical output. */

import { CHIPS, chipChannels } from "../chips/index.ts";
import { defaultSong } from "../normalize/defaults.ts";
import type {
  ChipId,
  EngineEvent,
  Instrument,
  RenderOptions,
  RenderResult,
  Sfx,
  Song,
} from "../types.ts";
import { PPQ } from "../types.ts";
import { compileSfx } from "./sfx-compile.ts";
import { SynthImpl } from "./synth.ts";
import type { SongTimeline } from "./timeline.ts";
import { compileSong } from "./timeline.ts";
import { BLOCK } from "./voice.ts";

const DEFAULT_RATE = 48_000;
/** -90 dBFS: sfx are trimmed after the last frame above this. */
const SILENCE = 10 ** (-90 / 20);
const PROGRESS_FRAMES = 65_536;
/** Hard cap on one render: 30 minutes. */
const MAX_SECONDS = 1800;

class Growable {
  data: Float32Array;
  len = 0;

  constructor(cap: number) {
    this.data = new Float32Array(Math.max(1024, cap));
  }

  append(src: Float32Array, n: number): void {
    if (this.len + n > this.data.length) {
      const next = new Float32Array(
        Math.max(this.data.length * 2, this.len + n)
      );
      next.set(this.data.subarray(0, this.len));
      this.data = next;
    }
    this.data.set(src.subarray(0, n), this.len);
    this.len += n;
  }

  /** frames starting at skip, padded with zeros to exactly count. */
  take(skip: number, count: number): Float32Array {
    const out = new Float32Array(count);
    const avail = Math.max(0, Math.min(count, this.len - skip));
    if (avail > 0) {
      out.set(this.data.subarray(skip, skip + avail));
    }
    return out;
  }
}

function copyEvents(src: EngineEvent[], into: EngineEvent[]): void {
  for (const e of src) {
    into.push({ ...e });
  }
  src.length = 0;
}

/** Song and instrument renders keep their own master volume; a master in the options only sets the limiter. */
function applyRenderMaster(synth: SynthImpl, opts?: RenderOptions): void {
  if (opts?.master) {
    synth.setRenderMaster(null, opts.master.limiter);
  }
}

interface Run {
  aborted: boolean;
  readonly bufL: Float32Array;
  readonly bufR: Float32Array;
  events: EngineEvent[];
  /** Frames at the last progress callback, kept across runFrames calls. */
  lastProgress: number;
  left: Growable;
  right: Growable;
  stems: Growable[];
  synth: SynthImpl;
}

function newRun(
  sampleRate: number,
  seed: number,
  stemCount: number,
  sfxVoices: number
): Run {
  const synth = new SynthImpl({ sampleRate, scopeFrames: 64, sfxVoices });
  synth.setSeed(seed);
  const stems: Growable[] = [];
  if (stemCount > 0) {
    synth.captureStems = true;
    for (let i = 0; i < stemCount; i += 1) {
      stems.push(new Growable(sampleRate * 4));
    }
  }
  return {
    aborted: false,
    bufL: new Float32Array(BLOCK),
    bufR: new Float32Array(BLOCK),
    events: [],
    lastProgress: 0,
    left: new Growable(sampleRate * 4),
    right: new Growable(sampleRate * 4),
    stems,
    synth,
  };
}

/** Run frames more frames. Returns false when the progress callback aborted. */
function runFrames(
  run: Run,
  frames: number,
  opts: RenderOptions | undefined,
  estimate: () => number
): boolean {
  const l = run.bufL;
  const r = run.bufR;
  const out: EngineEvent[] = [];
  let done = 0;
  while (done < frames) {
    const n = Math.min(BLOCK, frames - done);
    run.synth.process(l, r, n, out);
    run.left.append(l, n);
    run.right.append(r, n);
    for (let i = 0; i < run.stems.length; i += 1) {
      const b = run.synth.blockStems[i];
      if (b) {
        run.stems[i]?.append(b, n);
      }
    }
    copyEvents(out, run.events);
    done += n;
    if (
      opts?.onProgress &&
      run.left.len - run.lastProgress >= PROGRESS_FRAMES
    ) {
      run.lastProgress = run.left.len;
      if (
        opts.onProgress(run.left.len, Math.max(run.left.len, estimate())) ===
        false
      ) {
        run.aborted = true;
        return false;
      }
    }
  }
  return true;
}

/** Exact frame of a pulse under the song's tempo map, with the sequencer's own arithmetic. */
function pulseToFrame(
  tl: SongTimeline,
  sampleRate: number,
  pulse: number
): number {
  let frame = 0;
  let prev = 0;
  let spp = (sampleRate * 60) / ((tl.tempos[0]?.[1] ?? 120) * PPQ);
  for (let i = 1; i < tl.tempos.length; i += 1) {
    const t = tl.tempos[i];
    if (!t || t[0] > pulse) {
      break;
    }
    frame += (t[0] - prev) * spp;
    prev = t[0];
    spp = (sampleRate * 60) / (t[1] * PPQ);
  }
  return Math.ceil(frame + (pulse - prev) * spp - 1e-6);
}

function finish(
  run: Run,
  sampleRate: number,
  skip: number,
  frames: number,
  extra: Partial<RenderResult>
): RenderResult {
  const res: RenderResult = {
    channels: [run.left.take(skip, frames), run.right.take(skip, frames)],
    events: run.events.filter((e) => e.frame < frames),
    frames,
    sampleRate,
    ...extra,
  };
  return res;
}

export function renderSfx(sfx: Sfx, opts?: RenderOptions): RenderResult {
  const sr = opts?.sampleRate ?? DEFAULT_RATE;
  const seed = opts?.seed ?? 1;
  const tail = opts?.tail ?? 0.25;
  const run = newRun(sr, seed, 0, 1);
  if (opts?.master) {
    run.synth.setRenderMaster(opts.master.volume, opts.master.limiter);
  }
  const prog = compileSfx(sfx, sr);
  run.synth.loadSfx("sfx", sfx);
  run.synth.trigger("sfx", { seed });
  const latency = run.synth.latency;
  const want = Math.min(
    Math.round(MAX_SECONDS * sr),
    prog.totalFrames + Math.round(tail * sr) + latency + 1
  );
  runFrames(run, want, opts, () => want);
  // trim to the last frame above -90 dBFS plus 10 ms
  const l = run.left.take(latency, run.left.len - latency);
  const r = run.right.take(latency, run.right.len - latency);
  let last = -1;
  for (let i = l.length - 1; i >= 0; i -= 1) {
    if (Math.abs(l[i] ?? 0) > SILENCE || Math.abs(r[i] ?? 0) > SILENCE) {
      last = i;
      break;
    }
  }
  const frames = Math.max(
    1,
    Math.min(l.length, last + 1 + Math.round(0.01 * sr))
  );
  return {
    channels: [l.slice(0, frames), r.slice(0, frames)],
    events: run.events.filter((e) => e.frame < frames || e.type === "trigger"),
    frames,
    sampleRate: sr,
  };
}

/** How many frames a song render is expected to take: one pass, the extra loop passes and the tail. */
function songFrameEstimate(
  tl: SongTimeline,
  sr: number,
  passes: number,
  tail: number
): number {
  const end = pulseToFrame(tl, sr, tl.totalPulses);
  const passFrames =
    tl.loopPulse === null ? 0 : end - pulseToFrame(tl, sr, tl.loopPulse);
  return end + passFrames * (passes - 1) + Math.round(tail * sr);
}

/** The frame of the first loop event and of the next one (or the end): the pass a game loops over. */
function loopPoints(events: EngineEvent[]): [number, number] | null {
  const first = events.find((e) => e.type === "loop");
  if (!first) {
    return null;
  }
  const next =
    events.find((e) => e.type === "loop" && e.frame > first.frame) ??
    events.find((e) => e.type === "end");
  return next ? [first.frame, next.frame] : null;
}

/** What a song render adds to the result: the loop points in frames, and the stems when they were asked for. */
function songExtras(
  song: Song,
  tl: SongTimeline,
  frames: number,
  run: Run,
  withStems: boolean
): Partial<RenderResult> {
  const extra: Partial<RenderResult> = {};
  // The loop is the second pass: it starts with the release tails of the first pass still sounding and ends where the
  // third pass would begin, so wrapping from its end to its start continues the music instead of cutting it.
  const points = tl.loopPulse === null ? null : loopPoints(run.events);
  if (points) {
    [extra.loopStart, extra.loopEnd] = points;
  }
  if (withStems) {
    const ids = chipChannels(song).slice(0, 10);
    extra.stemIds = ids.map((c) => c.id);
    extra.stems = run.stems.map((g) => g.take(0, frames));
  }
  return extra;
}

/** Passes a looping song renders: the first after the intro, then the one a game repeats; `loops` counts the passes
    after the first, so 1 (the default) is that minimum and 3 adds two more. */
function songPasses(opts?: RenderOptions): number {
  return Math.max(1, Math.floor(opts?.loops ?? 1)) + 1;
}

/** Run a prepared song render until the sequencer ends, then through `tail` seconds of release. */
function driveSong(
  run: Run,
  opts: RenderOptions | undefined,
  latency: number,
  estimate: () => number
): number {
  const sr = run.synth.sampleRate;
  const maxFrames = Math.round(MAX_SECONDS * sr);
  while (!run.synth.ended && run.left.len < maxFrames) {
    if (!runFrames(run, BLOCK, opts, estimate)) {
      break;
    }
  }
  const endFrame =
    run.events.find((e) => e.type === "end")?.frame ?? run.left.len;
  const desired = endFrame + Math.round((opts?.tail ?? 1) * sr) + latency;
  if (!run.aborted && run.left.len < desired) {
    runFrames(run, desired - run.left.len, opts, estimate);
  }
  return Math.min(run.left.len, desired) - latency;
}

export function renderSong(
  song: Song,
  instruments: Record<string, Instrument>,
  opts?: RenderOptions
): RenderResult {
  const sr = opts?.sampleRate ?? DEFAULT_RATE;
  const stemCount = opts?.stems ? chipChannels(song).length : 0;
  const run = newRun(sr, opts?.seed ?? 1, Math.min(stemCount, 10), 1);
  const synth = run.synth;
  synth.loadSong(song, instruments);
  applyRenderMaster(synth, opts);
  const tl = compileSong(song, instruments);
  const latency = synth.latency;
  const looping = tl.loopPulse !== null;
  const passes = looping ? songPasses(opts) : 1;
  const estimate = songFrameEstimate(tl, sr, passes, opts?.tail ?? 1);
  synth.playForRender(passes);
  const frames = Math.max(
    0,
    driveSong(run, opts, latency, () => estimate)
  );
  const extra = songExtras(song, tl, frames, run, Boolean(opts?.stems));
  return finish(run, sr, latency, frames, extra);
}

export function renderInstrumentNote(
  inst: Instrument,
  note: number,
  opts?: RenderOptions & { chip?: ChipId; duration?: number; release?: number }
): RenderResult {
  const sr = opts?.sampleRate ?? DEFAULT_RATE;
  const seed = opts?.seed ?? 1;
  const duration = opts?.duration ?? 0.5;
  const release = opts?.release ?? 0.5;
  let chip: ChipId = opts?.chip ?? inst.chip ?? "custom";
  let index = CHIPS[chip].channels.findIndex((c) => c.kind === inst.kind);
  if (index < 0) {
    chip = "custom";
    index = CHIPS.custom.channels.findIndex((c) => c.kind === inst.kind);
  }
  const song = defaultSong(chip);
  const run = newRun(sr, seed, 0, 1);
  const synth = run.synth;
  synth.loadSong(song, { inst });
  applyRenderMaster(synth, opts);
  const latency = synth.latency;
  synth.noteOn(Math.max(0, index), note, 1, "inst");
  runFrames(run, Math.round(duration * sr), opts, () =>
    Math.round((duration + release) * sr)
  );
  synth.noteOff(Math.max(0, index));
  runFrames(run, Math.round(release * sr) + latency, opts, () =>
    Math.round((duration + release) * sr)
  );
  const frames = Math.max(0, run.left.len - latency);
  return finish(run, sr, latency, frames, {});
}
