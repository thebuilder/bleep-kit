/* CPU load meter for the worklet. AudioWorkletGlobalScope has no `performance` in most browsers, so the clock is
   looked up once and falls back to the millisecond wall clock, whose rounding averages out over many blocks. The
   reading only feeds the load figure in `clock` messages; it never touches the audio. */

export type NowFn = () => number;

interface ClockHost {
  Date?: { now: () => number };
  performance?: { now: () => number };
}

export function defaultNow(host: ClockHost = globalThis): NowFn | null {
  const perf = host.performance;
  if (perf && typeof perf.now === "function") {
    return () => perf.now();
  }
  const wall = host.Date;
  if (wall && typeof wall.now === "function") {
    return () => wall.now();
  }
  return null;
}

/** Exponential average of (time in process) / (block duration). */
export class LoadMeter {
  private average = 0;
  private readonly smoothing: number;

  constructor(smoothing = 0.02) {
    this.smoothing = smoothing;
  }

  add(busyMs: number, blockMs: number): void {
    if (blockMs <= 0) {
      return;
    }
    const load = Math.max(0, busyMs) / blockMs;
    this.average += (load - this.average) * this.smoothing;
  }

  get value(): number {
    return this.average;
  }
}
