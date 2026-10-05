// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: audio hot paths and long effect switches stay in one function: no call overhead and the order reads like the signal flow
// biome-ignore-all lint/style/useDestructuring: per-sample loops copy fields into locals on purpose, destructuring adds nothing there
// biome-ignore-all lint/suspicious/noBitwiseOperators: DSP code: LFSR shifts, power-of-two ring masks, integer hashing and flag masks need bit operations
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: Biome types fields initialised with false or 0 as literals and flags mutable state as constant
/* SongPlayer: walks a compiled SongTimeline on the sample clock. Event frames are a pure function of the schedule
   (a base pulse, the frame it started at and the samples per pulse of the current tempo), never of how the host
   splits blocks, so playback is identical for any block size. */

import { PPQ } from "../types.ts";
import type { RowMark, SongTimeline, TimelineEvent } from "./timeline.ts";

const EPS = 1e-6;
export const MAX_SEQ_CHANNELS = 10;

export interface SeqHandler {
  onEnd: (frame: number) => void;
  onEvent: (frame: number, channel: number, e: TimelineEvent) => void;
  onLoop: (frame: number) => void;
  onRow: (frame: number, mark: RowMark) => void;
}

const KIND_NONE = -1;
const KIND_TEMPO = 0;
const KIND_ROW = 1;
const KIND_CHANNEL = 2;
const KIND_END = 3;

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
    this.rowPtr = SongPlayer.lower(tl.rows, pulse);
    for (let c = 0; c < tl.tracks.length && c < MAX_SEQ_CHANNELS; c += 1) {
      const list = tl.tracks[c] ?? [];
      const ptr = SongPlayer.lower(list, pulse);
      this.chPtr[c] = ptr;
      if (state) {
        let inst: string | null = null;
        let vol: number | null = null;
        for (let i = 0; i < ptr; i += 1) {
          const e = list[i];
          if (e && (e.type === "note" || e.type === "fx")) {
            if (e.inst !== null) {
              inst = e.inst;
            }
            if (e.vol !== null) {
              vol = e.vol;
            }
          }
        }
        state(c, inst, vol);
      }
    }
    this.ended = false;
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
    // earlier sources win ties: tempo, then rows, then channels, then the end
    let best = Number.POSITIVE_INFINITY;
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
      switch (this.kind) {
        case KIND_TEMPO: {
          const t = tl.tempos[this.tempoPtr];
          if (t) {
            const exact = this.baseFrame + (t[0] - this.basePulse) * this.spp;
            this.basePulse = t[0];
            this.baseFrame = exact;
            this.setTempo(t[1]);
          }
          this.tempoPtr += 1;
          break;
        }
        case KIND_ROW: {
          const m = tl.rows[this.rowPtr];
          this.rowPtr += 1;
          if (m) {
            h.onRow(at, m);
          }
          break;
        }
        case KIND_CHANNEL: {
          const c = this.kindCh;
          const e = tl.tracks[c]?.[this.chPtr[c] ?? 0];
          this.chPtr[c] = (this.chPtr[c] ?? 0) + 1;
          if (e) {
            h.onEvent(at, c, e);
          }
          break;
        }
        default: {
          const exact =
            this.baseFrame + (tl.totalPulses - this.basePulse) * this.spp;
          if (tl.loopPulse !== null && this.loopsRemaining > 1) {
            this.loopsRemaining -= 1;
            this.basePulse = tl.loopPulse;
            this.baseFrame = exact;
            this.setTempo(this.tempoAt(tl.loopPulse));
            this.rowPtr = SongPlayer.lower(tl.rows, tl.loopPulse);
            for (
              let c = 0;
              c < tl.tracks.length && c < MAX_SEQ_CHANNELS;
              c += 1
            ) {
              this.chPtr[c] = SongPlayer.lower(
                tl.tracks[c] ?? [],
                tl.loopPulse
              );
            }
            h.onLoop(at);
          } else {
            this.running = false;
            this.ended = true;
            this.pausedPulse = tl.totalPulses;
            h.onEnd(at);
            return;
          }
          break;
        }
      }
    }
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
