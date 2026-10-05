/* SongPlayer: walks a compiled SongTimeline on the sample clock. Event frames are a pure function of the schedule
   (a base pulse, the frame it started at and the samples per pulse of the current tempo), never of how the host
   splits blocks, so playback is identical for any block size. */

import { PPQ } from "../types.ts";
import type { RowMark, SongTimeline, TimelineEvent } from "./timeline.ts";

const EPS = 1e-6;
const MAX_SEQ_CHANNELS = 10;

export interface SeqHandler {
  onEnd: (frame: number) => void;
  onEvent: (frame: number, channel: number, e: TimelineEvent) => void;
  onLoop: (frame: number) => void;
  onRow: (frame: number, mark: RowMark) => void;
  /** The first pass reaches the start of the loop section (not called when the song starts there). */
  onSection: (frame: number) => void;
}

const KIND_NONE = -1;
const KIND_TEMPO = 0;
const KIND_ROW = 1;
const KIND_CHANNEL = 2;
const KIND_END = 3;
const KIND_SECTION = 4;

/** The instrument and volume set by the events in `list` before index `end`: what a channel holds after them. */
function persistentState(
  list: readonly TimelineEvent[],
  end: number
): [string | null, number | null] {
  let inst: string | null = null;
  let vol: number | null = null;
  for (let i = 0; i < end; i += 1) {
    const e = list[i];
    if (e && (e.type === "note" || e.type === "fx")) {
      inst = e.inst ?? inst;
      vol = e.vol ?? vol;
    }
  }
  return [inst, vol];
}

export class SongPlayer {
  tl: SongTimeline | null = null;
  readonly sr: number;
  /** True while the sequencer is running (not paused, stopped or ended). */
  running = false;
  ended = false;
  /** Passes through the loop section still to play (Infinity: forever). */
  loopsRemaining = 1;
  tempoScale = 1;

  private basePulse = 0;
  private baseFrame = 0;
  private spp = 1;
  private bpm = 120;
  private rowPtr = 0;
  private tempoPtr = 0;
  private readonly chPtr = new Int32Array(MAX_SEQ_CHANNELS);
  private pausedPulse = 0;
  /** The first pass has not reached the loop section yet. */
  private sectionPending = false;

  // result of the last peek()
  private kind = KIND_NONE;
  private kindCh = 0;
  private kindPulse = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
  }

  load(tl: SongTimeline): void {
    this.tl = tl;
    this.running = false;
    this.ended = false;
    this.pausedPulse = 0;
    this.rowPtr = 0;
    this.tempoPtr = 0;
    this.chPtr.fill(0);
  }

  unload(): void {
    this.tl = null;
    this.running = false;
    this.ended = false;
  }

  private setTempo(bpm: number): void {
    this.bpm = bpm;
    this.spp = (this.sr * 60) / (Math.max(1, bpm * this.tempoScale) * PPQ);
  }

  private tempoAt(pulse: number): number {
    const tl = this.tl;
    let bpm = 120;
    let ptr = 0;
    if (tl) {
      for (let i = 0; i < tl.tempos.length; i += 1) {
        const t = tl.tempos[i];
        if (t && t[0] <= pulse + EPS) {
          bpm = t[1];
          ptr = i + 1;
        } else {
          break;
        }
      }
    }
    this.tempoPtr = ptr;
    return bpm;
  }

  /** Index of the first element whose pulse is at least p. */
  private static lower<T extends { pulse: number }>(
    list: readonly T[],
    p: number
  ): number {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid]?.pulse ?? 0) < p - EPS) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /** Position the sequencer at a pulse, starting the clock at frame. Calls state(channel, inst, vol) for the persistent
      instrument and volume set by events before the position. */
  seekPulse(
    pulse: number,
    frame: number,
    state:
      | ((ch: number, inst: string | null, vol: number | null) => void)
      | null
  ): void {
    const tl = this.tl;
    if (!tl) {
      return;
    }
    this.basePulse = pulse;
    this.baseFrame = frame;
    this.pausedPulse = pulse;
    this.setTempo(this.tempoAt(pulse));
    this.placePointers(tl, pulse);
    this.sectionPending = tl.loopPulse !== null && tl.loopPulse > pulse + EPS;
    if (state) {
      for (let c = 0; c < tl.tracks.length && c < MAX_SEQ_CHANNELS; c += 1) {
        const list = tl.tracks[c] ?? [];
        const [inst, vol] = persistentState(list, this.chPtr[c] ?? 0);
        state(c, inst, vol);
      }
    }
    this.ended = false;
  }

  /** Point the row and channel cursors at the first row and events at or after `pulse`. */
  private placePointers(tl: SongTimeline, pulse: number): void {
    this.rowPtr = SongPlayer.lower(tl.rows, pulse);
    for (let c = 0; c < tl.tracks.length && c < MAX_SEQ_CHANNELS; c += 1) {
      this.chPtr[c] = SongPlayer.lower(tl.tracks[c] ?? [], pulse);
    }
  }

  /** Pulse of an (order, row) position: the first played row at or after it. */
  pulseOf(order: number, row: number): number {
    const tl = this.tl;
    if (!tl) {
      return 0;
    }
    for (const m of tl.rows) {
      if (m.order === order && m.row >= row) {
        return m.pulse;
      }
    }
    for (const m of tl.rows) {
      if (m.order >= order) {
        return m.pulse;
      }
    }
    return 0;
  }

  start(
    pulse: number,
    frame: number,
    loops: number,
    state:
      | ((ch: number, inst: string | null, vol: number | null) => void)
      | null
  ): void {
    this.seekPulse(pulse, frame, state);
    this.loopsRemaining = loops;
    this.running = true;
    this.ended = false;
  }

  pause(frame: number): void {
    if (!this.running) {
      return;
    }
    this.pausedPulse = this.pulseAt(frame);
    this.running = false;
  }

  resume(frame: number): void {
    if (this.running || !this.tl || this.ended) {
      return;
    }
    this.basePulse = this.pausedPulse;
    this.baseFrame = frame;
    this.running = true;
  }

  /** Change the tempo multiplier from here on. */
  setTempoScale(scale: number, frame: number): void {
    if (this.running) {
      const p = this.pulseAt(frame);
      this.basePulse = p;
      this.baseFrame = frame;
    }
    this.tempoScale = scale;
    this.setTempo(this.bpm);
  }

  pulseAt(frame: number): number {
    if (!this.running) {
      return this.pausedPulse;
    }
    return this.basePulse + (frame - this.baseFrame) / this.spp;
  }

  /** Samples per pulse at the current tempo (for tick-in-row estimates). */
  samplesPerPulse(): number {
    return this.spp;
  }

  frameOf(pulse: number): number {
    return Math.ceil(
      this.baseFrame + (pulse - this.basePulse) * this.spp - EPS
    );
  }

  private peek(): void {
    const tl = this.tl;
    this.kind = KIND_NONE;
    if (!tl) {
      return;
    }
    // earlier sources win ties: the loop section, tempo, then rows, then channels, then the end
    let best = Number.POSITIVE_INFINITY;
    if (this.sectionPending && tl.loopPulse !== null) {
      best = tl.loopPulse;
      this.kind = KIND_SECTION;
    }
    const tp = tl.tempos[this.tempoPtr];
    if (tp && tp[0] < best - EPS) {
      best = tp[0];
      this.kind = KIND_TEMPO;
    }
    const rp = tl.rows[this.rowPtr];
    if (rp && rp.pulse < best - EPS) {
      best = rp.pulse;
      this.kind = KIND_ROW;
    }
    for (let c = 0; c < tl.tracks.length && c < MAX_SEQ_CHANNELS; c += 1) {
      const e = tl.tracks[c]?.[this.chPtr[c] ?? 0];
      if (e && e.pulse < best - EPS) {
        best = e.pulse;
        this.kind = KIND_CHANNEL;
        this.kindCh = c;
      }
    }
    if (tl.totalPulses < best - EPS || this.kind === KIND_NONE) {
      best = tl.totalPulses;
      this.kind = KIND_END;
    }
    this.kindPulse = best;
  }

  /** The frame of the next event, or Infinity when the sequencer is not running. */
  nextFrame(): number {
    if (!(this.running && this.tl)) {
      return Number.POSITIVE_INFINITY;
    }
    this.peek();
    return this.kind === KIND_NONE
      ? Number.POSITIVE_INFINITY
      : this.frameOf(this.kindPulse);
  }

  /** Fire every event due at or before frame. */
  advance(frame: number, h: SeqHandler): void {
    const tl = this.tl;
    for (let guard = 0; guard < 4096 && this.running && tl; guard += 1) {
      this.peek();
      if (this.kind === KIND_NONE) {
        return;
      }
      const ef = Math.max(this.frameOf(this.kindPulse), 0);
      if (ef > frame) {
        return;
      }
      const at = Math.min(ef, frame);
      if (this.kind === KIND_SECTION) {
        this.sectionPending = false;
        h.onSection(at);
      } else if (this.kind === KIND_TEMPO) {
        this.fireTempo(tl);
      } else if (this.kind === KIND_ROW) {
        this.fireRow(tl, h, at);
      } else if (this.kind === KIND_CHANNEL) {
        this.fireChannel(tl, h, at);
      } else if (this.reachEnd(tl, h, at)) {
        return;
      }
    }
  }

  private fireTempo(tl: SongTimeline): void {
    const t = tl.tempos[this.tempoPtr];
    if (t) {
      const exact = this.baseFrame + (t[0] - this.basePulse) * this.spp;
      this.basePulse = t[0];
      this.baseFrame = exact;
      this.setTempo(t[1]);
    }
    this.tempoPtr += 1;
  }

  private fireRow(tl: SongTimeline, h: SeqHandler, at: number): void {
    const m = tl.rows[this.rowPtr];
    this.rowPtr += 1;
    if (m) {
      h.onRow(at, m);
    }
  }

  private fireChannel(tl: SongTimeline, h: SeqHandler, at: number): void {
    const c = this.kindCh;
    const e = tl.tracks[c]?.[this.chPtr[c] ?? 0];
    this.chPtr[c] = (this.chPtr[c] ?? 0) + 1;
    if (e) {
      h.onEvent(at, c, e);
    }
  }

  /** The end of the song: jump back to the loop point while loops remain, else stop. True when it stopped. */
  private reachEnd(tl: SongTimeline, h: SeqHandler, at: number): boolean {
    const exact = this.baseFrame + (tl.totalPulses - this.basePulse) * this.spp;
    if (tl.loopPulse !== null && this.loopsRemaining > 1) {
      this.loopsRemaining -= 1;
      this.basePulse = tl.loopPulse;
      this.baseFrame = exact;
      this.setTempo(this.tempoAt(tl.loopPulse));
      this.placePointers(tl, tl.loopPulse);
      h.onLoop(at);
      return false;
    }
    this.running = false;
    this.ended = true;
    this.pausedPulse = tl.totalPulses;
    h.onEnd(at);
    return true;
  }

  /** The row currently playing, for position(). */
  currentRow(): RowMark | null {
    const tl = this.tl;
    if (!tl || tl.rows.length === 0) {
      return null;
    }
    let idx = this.rowPtr - 1;
    if (!(this.running || this.ended)) {
      // stopped or seeked: the row at the held pulse is the current one
      const next = tl.rows[this.rowPtr];
      if (next && Math.abs(next.pulse - this.pausedPulse) < EPS) {
        idx = this.rowPtr;
      }
    }
    return tl.rows[Math.max(0, Math.min(tl.rows.length - 1, idx))] ?? null;
  }
}
