/* The message and audio logic of the worklet processor, free of AudioWorkletGlobalScope so Node tests can drive it
   with a fake port and a fake synth. `BleepkitProcessor` (processor.ts) is the thin shell the browser instantiates. */

import type {
  EngineEvent,
  FromWorklet,
  Synth,
  SynthOptions,
  ToWorklet,
} from "@bleepkit/core";
import { defined } from "../util.ts";
import { LoadMeter, type NowFn } from "./load-meter.ts";

/** Frames between `clock` messages (section 5.2). */
export const CLOCK_FRAMES = 1024;
/** Frames of each scope ring posted when shared memory is not in use. */
const SCOPE_POST_FRAMES = 1024;
/** Blocks an `events` batch may wait before it is posted. */
const EVENT_FLUSH_BLOCKS = 4;
const EVENT_FLUSH_COUNT = 64;
/** Voice handles remembered for `release`; the oldest are forgotten beyond this. */
const MAX_HANDLES = 256;
const MAX_BLOCK = 128;

export interface EnginePort {
  postMessage: (message: FromWorklet, transfer?: Transferable[]) => void;
}

export interface EngineEnv {
  createSynth: (opts: SynthOptions) => Synth;
  currentTime: () => number;
  /** Millisecond clock for the load meter; null disables the figure. */
  now?: NowFn | null;
  sampleRate: number;
}

export interface EngineOptions {
  scopeFrames?: number;
  /** Post scope copies while no shared buffer is set. Default true. */
  scopes?: boolean;
  sfxVoices?: number;
}

/** The part of `clock` the player and the studio read besides frame and time. */
export type ClockMessage = Extract<FromWorklet, { type: "clock" }> & {
  /** Average share of the block time spent in the engine, 0 to 1 and above when overloaded. */
  load?: number;
};

function copyEvent(e: EngineEvent): EngineEvent {
  return {
    channel: e.channel,
    channelId: e.channelId,
    frame: e.frame,
    hz: e.hz,
    id: e.id,
    note: e.note,
    order: e.order,
    row: e.row,
    type: e.type,
    velocity: e.velocity,
  };
}

/** Copy the newest `n` frames out of a ring whose write position is `head`. */
function copyNewest(ring: Float32Array, head: number, n: number): Float32Array {
  const size = ring.length;
  const count = Math.min(n, size);
  const out = new Float32Array(count);
  let index = (((head - count) % size) + size) % size;
  for (let i = 0; i < count; i += 1) {
    out[i] = ring[index] ?? 0;
    index = index + 1 === size ? 0 : index + 1;
  }
  return out;
}

export class BleepkitEngine {
  private readonly port: EnginePort;
  private readonly env: EngineEnv;
  private readonly options: EngineOptions;
  private readonly synth: Synth | null = null;
  private readonly out: EngineEvent[] = [];
  private readonly handles = new Map<number, number>();
  private pending: EngineEvent[] = [];
  private blocksSinceFlush = 0;
  private framesSinceClock = CLOCK_FRAMES;
  private shared = false;
  private ended = false;
  private errorCooldown = 0;
  private lastError = "";
  private readonly meter = new LoadMeter();
  private readonly scratch = new Float32Array(MAX_BLOCK);

  constructor(port: EnginePort, env: EngineEnv, options: EngineOptions = {}) {
    this.port = port;
    this.env = env;
    this.options = options;
    try {
      this.synth = env.createSynth({
        sampleRate: env.sampleRate,
        ...defined({
          scopeFrames: options.scopeFrames,
          sfxVoices: options.sfxVoices,
        }),
      });
    } catch (error) {
      this.fail(error);
    }
    this.post({ sampleRate: env.sampleRate, type: "ready" });
  }

  /** Message from the main thread. Never throws. */
  handleMessage(data: unknown): void {
    try {
      if (typeof data !== "object" || data === null) {
        throw new Error("message is not an object");
      }
      this.dispatch(data as ToWorklet);
    } catch (error) {
      this.fail(error);
    }
  }

  /** One render quantum. Always returns true so the node stays alive; a failing synth renders silence. */
  process(outputs: Float32Array[][]): boolean {
    const [channels] = outputs;
    const left = channels?.[0];
    if (!left) {
      return true;
    }
    const right = channels[1] ?? this.scratch.subarray(0, left.length);
    this.errorCooldown -= left.length;
    try {
      this.render(left, right);
    } catch (error) {
      left.fill(0);
      right.fill(0);
      this.out.length = 0;
      this.fail(error);
    }
    return true;
  }

  private post(message: FromWorklet, transfer?: Transferable[]): void {
    try {
      this.port.postMessage(message, transfer);
    } catch {
      // a closed port has nobody left to tell
    }
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (message === this.lastError && this.errorCooldown > 0) {
      return;
    }
    this.lastError = message;
    this.errorCooldown = this.env.sampleRate;
    this.post({ message, type: "error" });
  }

  private requireSynth(): Synth {
    if (!this.synth) {
      throw new Error("the engine is not running");
    }
    return this.synth;
  }

  private dispatch(msg: ToWorklet): void {
    const synth = this.requireSynth();
    switch (msg.type) {
      case "loadSong":
        synth.loadSong(msg.song, msg.instruments);
        break;
      case "unloadSong":
        synth.unloadSong();
        break;
      case "loadSfx":
        synth.loadSfx(msg.id, msg.sfx);
        break;
      case "unloadSfx":
        synth.unloadSfx(msg.id);
        break;
      case "play":
        this.ended = false;
        synth.play(defined({ loop: msg.loop, order: msg.order, row: msg.row }));
        break;
      case "stop":
        synth.stop();
        break;
      case "pause":
        synth.pause();
        break;
      case "seek":
        synth.seek(msg.order, msg.row);
        break;
      case "trigger":
        this.trigger(synth, msg);
        break;
      case "release":
        this.release(synth, msg.handle);
        break;
      case "noteOn":
        if (msg.instrument === undefined) {
          synth.noteOn(msg.channel, msg.note, msg.velocity);
        } else {
          synth.noteOn(msg.channel, msg.note, msg.velocity, msg.instrument);
        }
        break;
      case "noteOff":
        synth.noteOff(msg.channel);
        break;
      case "setInstrument":
        synth.setInstrument(msg.id, msg.instrument);
        break;
      case "setChannel":
        synth.setChannel(
          msg.channel,
          defined({
            muted: msg.muted,
            pan: msg.pan,
            solo: msg.solo,
            volume: msg.volume,
          })
        );
        break;
      case "setMaster":
        synth.setMaster(defined({ limiter: msg.limiter, volume: msg.volume }));
        break;
      case "setTempo":
        synth.setTempo(msg.tempo);
        break;
      case "setScopeBuffer":
        synth.setScopeBuffer(msg.buffer);
        this.shared = msg.buffer !== null;
        break;
      default:
        throw new Error(
          `unknown message type "${String((msg as { type?: unknown }).type)}"`
        );
    }
  }

  private trigger(
    synth: Synth,
    msg: Extract<ToWorklet, { type: "trigger" }>
  ): void {
    const voice = synth.trigger(
      msg.id,
      defined({
        pan: msg.pan,
        pitch: msg.pitch,
        seed: msg.seed,
        velocity: msg.velocity,
      })
    );
    if (voice <= 0) {
      return;
    }
    this.handles.set(msg.handle, voice);
    if (this.handles.size > MAX_HANDLES) {
      const oldest = this.handles.keys().next();
      if (!oldest.done) {
        this.handles.delete(oldest.value);
      }
    }
  }

  private release(synth: Synth, handle: number): void {
    const voice = this.handles.get(handle);
    if (voice === undefined) {
      return;
    }
    this.handles.delete(handle);
    synth.release(voice);
  }

  private render(left: Float32Array, right: Float32Array): void {
    const { synth } = this;
    if (!synth) {
      left.fill(0);
      right.fill(0);
      return;
    }
    const startFrame = synth.frame;
    const startTime = this.env.currentTime();
    const clock = this.env.now;
    const t0 = clock ? clock() : 0;
    const total = Math.min(left.length, right.length);
    if (total <= MAX_BLOCK) {
      synth.process(left, right, total, this.out);
    } else {
      for (let at = 0; at < total; at += MAX_BLOCK) {
        const n = Math.min(MAX_BLOCK, total - at);
        synth.process(
          left.subarray(at, at + n),
          right.subarray(at, at + n),
          n,
          this.out
        );
      }
    }
    if (clock) {
      this.meter.add(clock() - t0, (total / this.env.sampleRate) * 1000);
    }
    this.drainEvents();
    this.flushEvents(startFrame, startTime, false);
    this.framesSinceClock += total;
    if (this.framesSinceClock >= CLOCK_FRAMES) {
      this.framesSinceClock = 0;
      this.postClock(synth, startFrame, startTime);
    }
  }

  private drainEvents(): void {
    const { out } = this;
    for (const e of out) {
      this.pending.push(copyEvent(e));
      if (e.type === "end") {
        this.ended = true;
      }
    }
    out.length = 0;
  }

  private flushEvents(clockFrame: number, clockTime: number, force: boolean) {
    this.blocksSinceFlush += 1;
    const due =
      this.pending.length >= EVENT_FLUSH_COUNT ||
      this.blocksSinceFlush >= EVENT_FLUSH_BLOCKS ||
      this.ended ||
      force;
    if (!due) {
      return;
    }
    if (this.pending.length > 0) {
      const events = this.pending;
      this.pending = [];
      this.post({ clockFrame, clockTime, events, type: "events" });
    }
    this.blocksSinceFlush = 0;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome types a field initialised with false as the literal false, but drainEvents sets it
    if (this.ended) {
      this.ended = false;
      this.post({ type: "ended" });
    }
  }

  private postClock(synth: Synth, frame: number, time: number): void {
    const message: ClockMessage = {
      frame,
      load: this.env.now ? this.meter.value : 0,
      playing: synth.playing,
      position: synth.position(),
      time,
      type: "clock",
    };
    this.post(message);
    if (this.options.scopes !== false && !this.shared) {
      this.postScopes(synth);
    }
  }

  private postScopes(synth: Synth): void {
    const rings = synth.scopes;
    const head = rings.head[0] ?? 0;
    const buffers = rings.channels.map((ring) =>
      copyNewest(ring, head, SCOPE_POST_FRAMES)
    );
    const master = rings.master.map((ring) =>
      copyNewest(ring, head, SCOPE_POST_FRAMES)
    );
    this.post(
      { buffers, frame: synth.frame, master, type: "scope" },
      [...buffers, ...master].map((b) => b.buffer)
    );
  }
}
