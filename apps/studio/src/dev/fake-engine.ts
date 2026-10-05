/* A stand-in for the AudioWorklet engine (section 10): the same EngineNodeLike surface, built on the main thread.
   Sounds are rendered offline with renderSfx / renderSong / renderInstrumentNote and played through
   AudioBufferSourceNodes. A setInterval posts clock, events and scope data, so every view can be built and tested
   without a worklet. `?engine=fake` selects it, and the DOM tests use it. */

import type { EngineNodeLike, ScopeReaderLike } from "../engine/types.ts";
import type {
  EngineEvent,
  FromWorklet,
  Instrument,
  RenderResult,
  Sfx,
  Song,
  SongPosition,
  ToWorklet,
} from "../lib/contract.ts";
import { renderInstrumentNote, renderSfx, renderSong } from "../lib/core.ts";

interface Voice {
  channel: number;
  end: number;
  gain: GainNode | null;
  handle: number;
  held: boolean;
  mono: Float32Array;
  source: AudioBufferSourceNode | null;
  start: number;
}

interface PlayOptions {
  channel: number;
  handle: number;
  held?: boolean;
  pan?: number;
  velocity?: number;
}

const TICK_MS = 25;
const CACHE_MAX = 80;

/** An engine event with every field filled in; `over` says what is different. */
const blankEvent = (
  frame: number,
  over: Partial<EngineEvent> & { type: EngineEvent["type"] }
): EngineEvent => ({
  channel: -1,
  channelId: "",
  frame,
  hz: 0,
  id: "",
  note: 0,
  order: -1,
  row: -1,
  velocity: 0,
  ...over,
});

const hzOfNote = (note: number): number => 440 * 2 ** ((note - 69) / 12);

type Handlers = {
  [K in ToWorklet["type"]]?: (msg: Extract<ToWorklet, { type: K }>) => void;
};

class FakeEngine implements EngineNodeLike {
  readonly node: GainNode | null;
  readonly scopes: ScopeReaderLike;
  private readonly ctx: BaseAudioContext | null;
  private readonly sr: number;
  private readonly t0 =
    typeof performance === "undefined" ? 0 : performance.now();
  private readonly listeners = new Set<(m: FromWorklet) => void>();
  private readonly sfxDocs = new Map<string, Sfx>();
  private readonly instruments = new Map<string, Instrument>();
  private readonly renderCache = new Map<string, RenderResult>();
  private readonly scopeBuffers = new Map<string, Float32Array>();
  private song: Song | null = null;
  private songInstruments: Record<string, Instrument> = {};
  private limiter = true as boolean;
  private voices: Voice[] = [];
  private songRes: RenderResult | null = null;
  private songSource: AudioBufferSourceNode | null = null;
  private playing = false as boolean;
  /** Render-domain frame at engine frame `anchorEngine`. */
  private anchorRender = 0;
  private anchorEngine = 0;
  private lastEmitRender = -1;
  private looping = true as boolean;
  private lastClock = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(ctx: BaseAudioContext | null) {
    this.ctx = ctx;
    this.sr = ctx?.sampleRate ?? 48_000;
    this.node = ctx ? ctx.createGain() : null;
    if (ctx && this.node) {
      this.node.connect(ctx.destination);
      this.node.gain.value = 0.8;
    }
    this.scopes = {
      at: (channel, frame, frames) => this.scopeAt(channel, frame, frames),
      latest: (channel, frames) =>
        this.scopeAt(channel, this.nowFrame() - frames, frames),
    };
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /* ----- the EngineNodeLike surface ----- */

  nowFrame = (): number =>
    this.ctx
      ? Math.floor(this.ctx.currentTime * this.sr)
      : Math.floor(((performance.now() - this.t0) / 1000) * this.sr);

  on(handler: (m: FromWorklet) => void): () => void {
    this.listeners.add(handler);
    this.emit({ sampleRate: this.sr, type: "ready" });
    return () => this.listeners.delete(handler);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.stopSource();
    this.listeners.clear();
  }

  send(msg: ToWorklet): void {
    (this.handlers[msg.type] as ((m: ToWorklet) => void) | undefined)?.(msg);
  }

  /* ----- messages ----- */

  private readonly handlers: Handlers = {
    loadSfx: (m) => this.sfxDocs.set(m.id, m.sfx),
    loadSong: (m) => {
      this.song = m.song;
      this.songInstruments = m.instruments;
    },
    noteOff: (m) => {
      this.releaseHeld((v) => v.channel === m.channel, 0.06);
      this.announce({ channel: m.channel, type: "noteOff" });
    },
    noteOn: (m) => this.noteOn(m),
    pause: () => {
      this.anchorRender = this.renderFrameNow();
      this.stopSource();
      this.playing = false;
    },
    play: (m) => this.startSong(m.order, m.row, m.loop),
    release: (m) => this.releaseHeld((v) => v.handle === m.handle, 0.03),
    seek: (m) => {
      if (this.playing || this.songRes) {
        this.startSong(m.order, m.row, this.looping);
      }
    },
    setInstrument: (m) => {
      this.instruments.set(m.id, m.instrument);
      this.songInstruments = {
        ...this.songInstruments,
        [m.id]: m.instrument,
      };
    },
    setMaster: (m) => this.setMaster(m),
    stop: () => this.stop(),
    trigger: (m) => this.trigger(m),
    unloadSfx: (m) => this.sfxDocs.delete(m.id),
    unloadSong: () => {
      this.stopSource();
      this.playing = false;
      this.song = null;
      this.songRes = null;
    },
  };

  private setMaster(m: { volume?: number; limiter?: boolean }): void {
    if (m.volume !== undefined && this.node) {
      this.node.gain.value = m.volume;
    }
    if (m.limiter !== undefined && m.limiter !== this.limiter) {
      this.limiter = m.limiter;
      this.renderCache.clear();
    }
  }

  private stop(): void {
    this.stopSource();
    this.playing = false;
    this.anchorRender = 0;
    for (const v of this.voices) {
      v.source?.stop();
    }
    this.voices = [];
    this.emit({
      frame: this.nowFrame(),
      playing: false,
      position: null,
      time: this.ctx?.currentTime ?? 0,
      type: "clock",
    });
  }

  private trigger(m: Extract<ToWorklet, { type: "trigger" }>): void {
    const sfx = this.sfxDocs.get(m.id);
    if (!sfx) {
      return;
    }
    this.play(this.sfxResult(sfx), {
      channel: -1,
      handle: m.handle,
      velocity: m.velocity ?? 1,
    });
    this.announce({
      hz: sfx.frequency.start,
      id: m.id,
      type: "trigger",
      velocity: m.velocity ?? 1,
    });
  }

  private noteOn(m: Extract<ToWorklet, { type: "noteOn" }>): void {
    const id = m.instrument ?? "";
    const inst = this.instruments.get(id) ?? this.songInstruments[id];
    if (!inst) {
      return;
    }
    const r = this.cached(
      this.cacheKey("note", inst, `${m.note}:${this.sr}`),
      () =>
        renderInstrumentNote(inst, m.note, {
          duration: 0.6,
          master: this.renderMaster(),
          release: 0.4,
          sampleRate: this.sr,
        })
    );
    this.releaseHeld((v) => v.channel === m.channel, 0.02);
    this.play(r, {
      channel: m.channel,
      handle: 0,
      held: true,
      velocity: m.velocity,
    });
    this.announce({
      channel: m.channel,
      hz: hzOfNote(m.note),
      id,
      note: m.note,
      type: "noteOn",
      velocity: m.velocity,
    });
  }

  /* ----- rendering ----- */

  /** Volume is the output gain node's job here (it follows the slider live), so renders ask for unity. */
  private readonly renderMaster = () => ({ limiter: this.limiter, volume: 1 });

  private cacheKey(kind: string, doc: unknown, extra = ""): string {
    return `${kind}:${extra}:${this.limiter}:${JSON.stringify(doc)}`;
  }

  private cached(key: string, make: () => RenderResult): RenderResult {
    let r = this.renderCache.get(key);
    if (!r) {
      r = make();
      this.renderCache.set(key, r);
      if (this.renderCache.size > CACHE_MAX) {
        this.renderCache.delete(this.renderCache.keys().next().value as string);
      }
    }
    return r;
  }

  private sfxResult(sfx: Sfx): RenderResult {
    return this.cached(this.cacheKey("sfx", sfx, String(this.sr)), () =>
      renderSfx(sfx, { master: this.renderMaster(), sampleRate: this.sr })
    );
  }

  /* ----- voices (sfx and keyboard notes), kept for the scopes ----- */

  private bufferOf(r: RenderResult): AudioBuffer | null {
    if (!this.ctx) {
      return null;
    }
    const b = this.ctx.createBuffer(2, Math.max(1, r.frames), r.sampleRate);
    b.copyToChannel(r.channels[0] as Float32Array<ArrayBuffer>, 0);
    b.copyToChannel(
      (r.channels[1] ?? r.channels[0]) as Float32Array<ArrayBuffer>,
      1
    );
    return b;
  }

  private monoOf(r: RenderResult): Float32Array {
    const m = new Float32Array(r.frames);
    const [a] = r.channels;
    const b = r.channels[1] ?? a;
    for (let i = 0; i < r.frames; i += 1) {
      m[i] = ((a?.[i] ?? 0) + (b?.[i] ?? 0)) / 2;
    }
    return m;
  }

  private play(r: RenderResult, opts: PlayOptions): void {
    const start = this.nowFrame();
    const voice: Voice = {
      channel: opts.channel,
      end: start + r.frames,
      gain: null,
      handle: opts.handle,
      held: !!opts.held,
      mono: this.monoOf(r),
      source: null,
      start,
    };
    const { ctx, node } = this;
    if (ctx && node) {
      const src = ctx.createBufferSource();
      src.buffer = this.bufferOf(r);
      const g = ctx.createGain();
      g.gain.value = opts.velocity ?? 1;
      src.connect(g);
      g.connect(node);
      src.start();
      voice.source = src;
      voice.gain = g;
    }
    this.voices.push(voice);
    this.voices = this.voices.filter((v) => v.end > start - this.sr);
  }

  /** Fade out the held voices that match, over a time constant of `seconds`. */
  private releaseHeld(match: (v: Voice) => boolean, seconds: number): void {
    for (const v of this.voices) {
      if (v.held && match(v)) {
        v.gain?.gain.setTargetAtTime(0, this.ctx?.currentTime ?? 0, seconds);
        v.held = false;
      }
    }
  }

  /* ----- the song ----- */

  private wrapRender(f: number): number {
    const r = this.songRes;
    if (!r) {
      return 0;
    }
    const { loopStart: ls, loopEnd: le } = r;
    if (this.looping && ls !== undefined && le !== undefined && f >= le) {
      return ls + ((f - le) % Math.max(1, le - ls));
    }
    return f;
  }

  private renderFrameAt(engineFrame: number): number {
    return this.wrapRender(
      Math.max(0, this.anchorRender + (engineFrame - this.anchorEngine))
    );
  }

  private renderFrameNow(): number {
    return this.wrapRender(
      this.anchorRender + (this.nowFrame() - this.anchorEngine)
    );
  }

  private stopSource(): void {
    try {
      this.songSource?.stop();
    } catch {
      // already stopped
    }
    this.songSource?.disconnect();
    this.songSource = null;
  }

  /** The render frame to start from: a row asked for, a resume after a pause, or the top. */
  private startFrameFor(
    r: RenderResult,
    order: number | undefined,
    row: number | undefined
  ): number {
    if (order !== undefined || row !== undefined) {
      const hit = r.events.find(
        (e) =>
          e.type === "row" && e.order === (order ?? 0) && e.row === (row ?? 0)
      );
      return hit?.frame ?? 0;
    }
    return !this.playing &&
      this.anchorRender > 0 &&
      this.anchorRender < r.frames
      ? this.anchorRender
      : 0;
  }

  private startSource(r: RenderResult, startFrame: number): void {
    const { ctx, node } = this;
    if (!(ctx && node)) {
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.bufferOf(r);
    if (this.looping && r.loopStart !== undefined && r.loopEnd !== undefined) {
      src.loop = true;
      src.loopStart = r.loopStart / r.sampleRate;
      src.loopEnd = r.loopEnd / r.sampleRate;
    }
    src.connect(node);
    src.start(0, startFrame / r.sampleRate);
    this.songSource = src;
  }

  private startSong(order?: number, row?: number, loop?: boolean): void {
    const { song } = this;
    if (!song) {
      return;
    }
    const insts = this.songInstruments;
    const r = this.cached(
      this.cacheKey("song", { i: insts, song }, String(this.sr)),
      () =>
        renderSong(song, insts, {
          master: this.renderMaster(),
          sampleRate: this.sr,
          stems: true,
          tail: 0.5,
        })
    );
    this.songRes = r;
    this.looping = loop ?? true;
    const startFrame = this.startFrameFor(r, order, row);
    this.stopSource();
    this.startSource(r, startFrame);
    this.anchorRender = startFrame;
    this.anchorEngine = this.nowFrame();
    this.lastEmitRender = startFrame - 1;
    this.playing = true;
  }

  /* ----- scopes ----- */

  private scopeBuffer(key: string, n: number): Float32Array {
    const k = `${key}:${n}`;
    let b = this.scopeBuffers.get(k);
    if (!b) {
      b = new Float32Array(n);
      this.scopeBuffers.set(k, b);
    }
    return b;
  }

  /** Add the part of one voice that overlaps the scope window starting at `frame`. */
  private mixVoice(o: Float32Array, frame: number, v: Voice): void {
    for (let i = 0; i < o.length; i += 1) {
      const k = frame + i - v.start;
      if (k >= 0 && k < v.mono.length) {
        o[i] = (o[i] ?? 0) + (v.mono[k] ?? 0);
      }
    }
  }

  /** The playing song's samples (`source`) over the scope window, read from the render with loops unrolled. */
  private copySongSamples(
    o: Float32Array,
    source: Float32Array | undefined,
    frame: number
  ): void {
    const base = this.renderFrameAt(frame);
    for (let i = 0; i < o.length; i += 1) {
      o[i] = source?.[this.wrapRender(base + i)] ?? 0;
    }
  }

  private scopeAt(
    channel: number,
    frame: number,
    frames: number
  ): Float32Array {
    const o = this.scopeBuffer(String(channel), frames);
    o.fill(0);
    const res = this.playing ? this.songRes : null;
    if (channel < 0) {
      if (res) {
        this.copySongSamples(
          o,
          res.channels[channel === -1 ? 0 : 1] ?? res.channels[0],
          frame
        );
      }
      for (const v of this.voices) {
        this.mixVoice(o, frame, v);
      }
      return o;
    }
    if (res?.stems?.[channel]) {
      this.copySongSamples(o, res.stems[channel], frame);
    }
    for (const v of this.voices) {
      if (v.channel === channel) {
        this.mixVoice(o, frame, v);
      }
    }
    return o;
  }

  /* ----- the clock: events and position every tick ----- */

  private emit(m: FromWorklet): void {
    for (const h of this.listeners) {
      h(m);
    }
  }

  /** Tell the listeners about one event, now. */
  private announce(
    e: Partial<EngineEvent> & { type: EngineEvent["type"] }
  ): void {
    const frame = this.nowFrame();
    this.emit({
      clockFrame: frame,
      clockTime: this.ctx?.currentTime ?? 0,
      events: [blankEvent(frame, e)],
      type: "events",
    });
  }

  /** The song's events between the last tick and the render frame `cur`, moved onto the engine clock. */
  private songEvents(frame: number, cur: number): EngineEvent[] {
    const res = this.songRes;
    if (!res) {
      return [];
    }
    const from = this.lastEmitRender;
    const wrapped = cur < from;
    const inWindow = (f: number) =>
      wrapped ? f > from || f <= cur : f > from && f <= cur;
    const events = res.events
      .filter((e) => e.type !== "end" && inWindow(e.frame))
      .map((e) => ({ ...e, frame: frame + (e.frame - cur) }));
    if (wrapped) {
      events.push(blankEvent(frame, { type: "loop" }));
    }
    this.lastEmitRender = cur;
    return events;
  }

  /** The last row event at or before `cur`, as the song position the transport shows. */
  private positionAt(cur: number): SongPosition | null {
    let lastRow: EngineEvent | undefined;
    for (const e of this.songRes?.events ?? []) {
      if (e.frame > cur) {
        break;
      }
      if (e.type === "row") {
        lastRow = e;
      }
    }
    if (!lastRow) {
      return null;
    }
    return {
      order: lastRow.order,
      pulse: Math.round(
        ((cur / this.sr) * ((this.song?.tempo ?? 120) * 96)) / 60
      ),
      row: lastRow.row,
      tick: 0,
    };
  }

  private tick(): void {
    const frame = this.nowFrame();
    const res = this.songRes;
    let events: EngineEvent[] = [];
    let pos: SongPosition | null = null;
    if (this.playing && res) {
      const cur = this.renderFrameNow();
      events = this.songEvents(frame, cur);
      pos = this.positionAt(cur);
      if (
        (res.loopStart === undefined || !this.looping) &&
        cur >= res.frames - 1
      ) {
        this.playing = false;
        events.push(blankEvent(frame, { type: "end" }));
        this.emit({ type: "ended" });
      }
    }
    if (events.length) {
      this.emit({
        clockFrame: frame,
        clockTime: this.ctx?.currentTime ?? 0,
        events,
        type: "events",
      });
    }
    if (frame - this.lastClock > this.sr / 20) {
      this.lastClock = frame;
      this.emit({
        frame,
        playing: this.playing,
        position: pos,
        time: this.ctx?.currentTime ?? 0,
        type: "clock",
      });
    }
  }
}

export function createFakeEngine(ctx: BaseAudioContext | null): EngineNodeLike {
  return new FakeEngine(ctx);
}
