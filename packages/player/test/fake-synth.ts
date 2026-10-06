/* A stand-in for createSynth (architecture section 10): writes a sine while something plays, emits one noteOn per
   `play`, reuses its event objects like the real engine, and records every call. */

import type {
  ChipChannel,
  EngineEvent,
  ScopeRings,
  SongPosition,
  Synth,
  SynthOptions,
} from "@bleepkit/core";

export interface FakeSynthOptions {
  /** Frames after `play` at which the song ends (emits "end"). */
  songFrames?: number;
  /** Throw from this method. */
  throwOn?: "process" | "loadSong" | "trigger" | "create";
  /** Voices `trigger` can hand out before it answers 0. */
  voices?: number;
}

export type FakeCall = [name: string, ...args: unknown[]];

const POOL = 16;
const RING = 2048;

function blankEvent(): EngineEvent {
  return {
    channel: 0,
    channelId: "",
    frame: 0,
    hz: 0,
    id: "",
    note: 0,
    order: -1,
    row: -1,
    type: "noteOn",
    velocity: 0,
  };
}

export class FakeSynth implements Synth {
  readonly sampleRate: number;
  readonly calls: FakeCall[] = [];
  readonly created: SynthOptions;
  frame = 0;
  /** Frames asked of each `process` call, in order. */
  readonly processed: number[] = [];
  playing = false as boolean;
  scopes: ScopeRings;
  readonly opts: FakeSynthOptions;
  private readonly pool: EngineEvent[] = Array.from(
    { length: POOL },
    blankEvent
  );
  private poolAt = 0;
  private queued: Partial<EngineEvent>[] = [];
  private voices = 0;
  private nextVoice = 1;
  private songPlayed = 0;
  private phase = 0;
  private position_: SongPosition | null = null;

  constructor(created: SynthOptions, opts: FakeSynthOptions = {}) {
    if (opts.throwOn === "create") {
      throw new Error("create failed");
    }
    this.created = created;
    this.sampleRate = created.sampleRate;
    this.opts = opts;
    const frames = created.scopeFrames ?? RING;
    this.scopes = {
      channels: Array.from({ length: 10 }, () => new Float32Array(frames)),
      frames,
      head: new Uint32Array(1),
      master: [new Float32Array(frames), new Float32Array(frames)],
    };
  }

  private nextEvent(): EngineEvent {
    const e = this.pool[this.poolAt % POOL] ?? blankEvent();
    this.poolAt += 1;
    return e;
  }

  private record(name: string, ...args: unknown[]): void {
    this.calls.push([name, ...args]);
  }

  loadSong(song: unknown, instruments: unknown): void {
    if (this.opts.throwOn === "loadSong") {
      throw new Error("loadSong failed");
    }
    this.record("loadSong", song, instruments);
  }
  unloadSong(): void {
    this.record("unloadSong");
  }
  loadSfx(id: string, sfx: unknown): void {
    this.record("loadSfx", id, sfx);
  }
  unloadSfx(id: string): void {
    this.record("unloadSfx", id);
  }
  setInstrument(id: string, inst: unknown): void {
    this.record("setInstrument", id, inst);
  }
  play(opts?: { order?: number; row?: number; loop?: boolean }): void {
    this.record("play", opts);
    this.playing = true;
    this.songPlayed = 0;
    this.position_ = {
      order: opts?.order ?? 0,
      pulse: 0,
      row: opts?.row ?? 0,
      tick: 0,
    };
    this.queued.push({
      channel: 0,
      channelId: "pulse1",
      hz: 440,
      id: "lead",
      note: 69,
      type: "noteOn",
      velocity: 1,
    });
  }
  stop(): void {
    this.record("stop");
    this.playing = false;
  }
  pause(): void {
    this.record("pause");
    this.playing = false;
  }
  seek(order: number, row: number): void {
    this.record("seek", order, row);
  }
  trigger(
    id: string,
    opts?: { velocity?: number; pan?: number; pitch?: number; seed?: number }
  ): number {
    this.record("trigger", id, opts);
    if (this.opts.throwOn === "trigger") {
      throw new Error("trigger failed");
    }
    if (this.voices >= (this.opts.voices ?? 8)) {
      return 0;
    }
    this.voices += 1;
    this.queued.push({
      channel: -1,
      id,
      type: "trigger",
      velocity: opts?.velocity ?? 1,
    });
    const voice = this.nextVoice;
    this.nextVoice += 1;
    return voice;
  }
  release(handle: number): void {
    this.record("release", handle);
  }
  noteOn(
    channel: number,
    note: number,
    velocity: number,
    instrument?: string
  ): void {
    this.record("noteOn", channel, note, velocity, instrument);
  }
  noteOff(channel: number): void {
    this.record("noteOff", channel);
  }
  setChannel(channel: number, opts: unknown): void {
    this.record("setChannel", channel, opts);
  }
  setMaster(opts: unknown): void {
    this.record("setMaster", opts);
  }
  setTempo(tempo: number): void {
    this.record("setTempo", tempo);
  }
  setScopeBuffer(buffer: SharedArrayBuffer | null): void {
    this.record("setScopeBuffer", buffer);
  }
  position(): SongPosition | null {
    return this.position_;
  }
  channels(): readonly ChipChannel[] {
    return [{ id: "pulse1", kind: "pulse", label: "Pulse 1" }];
  }

  process(
    left: Float32Array,
    right: Float32Array,
    frames: number,
    out: EngineEvent[]
  ): void {
    if (this.opts.throwOn === "process") {
      throw new Error("process failed");
    }
    this.processed.push(frames);
    const active = this.playing || this.voices > 0;
    const [ring] = this.scopes.channels;
    const [masterL] = this.scopes.master;
    const size = this.scopes.frames;
    for (let i = 0; i < frames; i += 1) {
      const v = active ? Math.sin(this.phase) * 0.1 : 0;
      this.phase += (2 * Math.PI * 440) / this.sampleRate;
      left[i] = v;
      right[i] = v;
      const at = (this.frame + i) % size;
      if (ring) {
        ring[at] = v;
      }
      masterL[at] = v;
    }
    for (const q of this.queued) {
      const e = this.nextEvent();
      Object.assign(e, blankEvent(), q, { frame: this.frame });
      out.push(e);
    }
    this.queued = [];
    if (this.playing && this.opts.songFrames !== undefined) {
      this.songPlayed += frames;
      if (this.songPlayed >= this.opts.songFrames) {
        this.playing = false;
        const e = this.nextEvent();
        Object.assign(e, blankEvent(), {
          frame: this.frame + frames,
          type: "end",
        });
        out.push(e);
      }
    }
    this.frame += frames;
    this.scopes.head[0] = this.frame % size;
  }
}

export function fakeSynthFactory(opts: FakeSynthOptions = {}) {
  const made: FakeSynth[] = [];
  const create = (synthOpts: SynthOptions): Synth => {
    const synth = new FakeSynth(synthOpts, opts);
    made.push(synth);
    return synth;
  };
  return { create, made };
}
