/* The studio's audio engine: one AudioContext and one engine node (the real AudioWorklet engine from
   @bleepkit/player, or the fake one for `?engine=fake` and whenever the real one is not there yet), wrapped in the
   calls the views use: trigger a sound, play a song, hold a note. It keeps the clock the visuals read from, and a queue
   of engine events that are handed out when they become audible. */
import { createEngineNode } from "@bleepkit/player";
import { createFakeEngine } from "../dev/fake-engine.ts";
import type {
  EngineEvent,
  Instrument,
  Sfx,
  Song,
  SongPosition,
} from "../lib/contract.ts";
import { fire } from "../lib/dom.ts";
import type { EngineNodeLike } from "./types.ts";

/* The worklet bundle is built by `pnpm --filter @bleepkit/player build:worklet`; until it exists the glob is empty. */
const WORKLETS = import.meta.glob(
  "../../../../packages/player/worklet/bleepkit-worklet.js",
  {
    eager: true,
    import: "default",
    query: "?url",
  }
) as Record<string, string>;
const WORKLET_URL = Object.values(WORKLETS)[0] ?? null;

type EngineStatus = "starting" | "locked" | "running" | "error";

/** The channel kinds hosted when no song is loaded (keyboard and instrument previews). */
const PREVIEW_KINDS = [
  "pulse",
  "triangle",
  "noise",
  "wave",
  "sid",
  "fm",
  "sample",
] as const;

class Engine {
  ctx: AudioContext | null = null;
  node: EngineNodeLike | null = null;
  fake = false as boolean;
  status: EngineStatus = "starting";
  error = "";
  sampleRate = 48_000;
  cpu = 0;
  // `as boolean`: a field started with a literal is typed as that literal by the linter, but these change at runtime
  playing = false as boolean;
  position: SongPosition | null = null;
  /** Engine frame the playing song counted from (for the time display), and the song's tempo. */
  private readonly listeners = new Set<() => void>();
  private readonly queue: EngineEvent[] = [];
  private readonly local: EngineEvent[] = [];
  private readonly sfxKeys = new Map<string, string>();
  private readonly instKeys = new Map<string, string>();
  private songKey = "";
  /** The document id of the song the worklet holds ("" when none, or when it was not loaded from a document). */
  private songId = "";
  /** A song was loaded and not started yet: clock messages already on their way still describe the old one. */
  private songFresh = false as boolean;
  private handle = 0;
  private offNode: (() => void) | null = null;
  private tempo = 120;

  /** Create the context and the engine node. Safe to call once; the context stays suspended until a gesture. */
  async init(opts: { fake?: boolean } = {}): Promise<void> {
    const wantFake =
      opts.fake ??
      new URLSearchParams(location.search).get("engine") === "fake";
    const Ctor = typeof AudioContext === "undefined" ? null : AudioContext;
    try {
      this.ctx = Ctor ? new Ctor({ latencyHint: "interactive" }) : null;
    } catch {
      this.ctx = null;
    }
    this.sampleRate = this.ctx?.sampleRate ?? 48_000;
    if (!wantFake && this.ctx && WORKLET_URL) {
      try {
        const real = await createEngineNode(this.ctx, {
          workletUrl: WORKLET_URL,
        });
        // createEngineNode leaves routing to the caller (the game player goes through its volume buses), so the
        // studio wires the engine straight to the speakers
        real.node.connect(this.ctx.destination);
        this.node = real;
        this.fake = false;
      } catch (err) {
        this.error = (err as Error).message;
        this.node = null;
      }
    }
    if (!this.node) {
      this.node = createFakeEngine(this.ctx);
      this.fake = true;
    }
    this.offNode = this.node.on((msg) => this.onMessage(msg));
    this.ctx?.addEventListener("statechange", () => this.syncStatus());
    this.syncStatus();
  }

  private syncStatus(): void {
    const prev = this.status;
    if (this.ctx) {
      this.status = this.ctx.state === "running" ? "running" : "locked";
    } else {
      this.status = "running";
    }
    if (prev !== this.status) {
      this.emit();
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      fn();
    }
  }

  private onMessage(msg: import("../lib/contract.ts").FromWorklet): void {
    switch (msg.type) {
      case "events":
        for (const e of msg.events) {
          // sounds the studio triggers announce themselves at once (see triggerSfx), so the engine's copy is dropped
          if (e.type !== "trigger") {
            this.queue.push({ ...e });
          }
        }
        if (this.queue.length > 4000) {
          this.queue.splice(0, this.queue.length - 2000);
        }
        break;
      case "clock": {
        this.position = this.songFresh ? null : msg.position;
        const was = this.playing;
        this.playing = this.songFresh ? false : msg.playing;
        const load = msg as { cpu?: number; load?: number };
        const cpu = load.load ?? load.cpu;
        if (typeof cpu === "number") {
          this.cpu = this.cpu * 0.8 + cpu * 0.2;
        }
        if (was !== this.playing) {
          this.emit();
        }
        break;
      }
      case "ended":
        this.playing = false;
        this.emit();
        break;
      case "error":
        this.error = msg.message;
        this.emit();
        break;
      default:
        break;
    }
  }

  /** Resume the AudioContext; call it from a user gesture. */
  async unlock(): Promise<void> {
    if (this.ctx && this.ctx.state !== "running") {
      try {
        await this.ctx.resume();
      } catch {
        // stays locked; the pill keeps asking
      }
    }
    this.syncStatus();
  }

  nowFrame(): number {
    // the real node reports a fractional frame, and scope rings are indexed by whole frames
    return Math.floor(this.node?.nowFrame() ?? 0);
  }

  get scopes() {
    return this.node?.scopes ?? null;
  }

  get latencyMs(): number {
    const c = this.ctx;
    return c
      ? Math.round(((c.outputLatency || c.baseLatency || 0) as number) * 1000)
      : 0;
  }

  /** Events that have become audible since the last call, plus the ones the studio made itself. */
  drain(): EngineEvent[] {
    const out: EngineEvent[] = [];
    if (this.local.length) {
      out.push(...this.local.splice(0));
    }
    if (this.queue.length) {
      const now = this.nowFrame();
      let n = 0;
      while (n < this.queue.length && (this.queue[n]?.frame ?? 0) <= now) {
        n += 1;
      }
      if (n) {
        out.push(...this.queue.splice(0, n));
      }
    }
    return out;
  }

  /** Announce an event to the visuals right now (a pad press does not wait for the worklet). */
  announce(e: Partial<EngineEvent> & { type: EngineEvent["type"] }): void {
    this.local.push({
      channel: -1,
      channelId: "",
      frame: -1,
      hz: 0,
      id: "",
      note: 0,
      order: -1,
      row: -1,
      velocity: 0,
      ...e,
    });
  }

  /* ----- sound effects ----- */

  triggerSfx(
    id: string,
    sfx: Sfx,
    opts: { velocity?: number; pan?: number; pitch?: number } = {}
  ): number {
    if (!this.node) {
      return 0;
    }
    const key = JSON.stringify(sfx);
    if (this.sfxKeys.get(id) !== key) {
      this.node.send({ id, sfx, type: "loadSfx" });
      this.sfxKeys.set(id, key);
    }
    this.handle += 1;
    const { handle } = this;
    this.node.send({ handle, id, type: "trigger", ...opts });
    this.announce({
      channelId: sfx.category,
      hz: sfx.frequency.start,
      id,
      type: "trigger",
      velocity: opts.velocity ?? 1,
    });
    return handle;
  }

  releaseSfx(handle: number): void {
    this.node?.send({ handle, type: "release" });
  }

  /* ----- songs ----- */

  loadSong(
    song: Song,
    instruments: Record<string, Instrument>,
    _channelIds: readonly string[],
    songId = ""
  ): void {
    if (!this.node) {
      return;
    }
    const key = JSON.stringify([song, instruments]);
    this.tempo = song.tempo;
    this.songId = songId;
    if (key !== this.songKey) {
      this.songKey = key;
      this.node.send({ instruments, song, type: "loadSong" });
      // a new song starts stopped at its top, whatever the last one was doing
      this.songFresh = true;
      this.position = null;
      if (this.playing) {
        this.playing = false;
        this.emit();
      }
      // the worklet drops every instrument it held and keeps exactly the ones the song came with
      this.instKeys.clear();
      for (const [id, inst] of Object.entries(instruments)) {
        this.instKeys.set(id, JSON.stringify(inst));
      }
    }
  }

  /** True while the worklet holds the song of document `id`: what plays, pauses or takes held notes is that song. */
  hasSong(id: string): boolean {
    return this.songKey !== "" && this.songId === id;
  }

  /** Drop the loaded song (and with it the worklet's instruments, so the next upload really sends them). */
  unloadSong(): void {
    if (this.songKey === "") {
      return;
    }
    this.node?.send({ type: "unloadSong" });
    this.songKey = "";
    this.songId = "";
    this.instKeys.clear();
  }

  playSong(opts: { order?: number; row?: number; loop?: boolean } = {}): void {
    this.songFresh = false;
    this.node?.send({ type: "play", ...opts });
    this.playing = true;
    this.emit();
  }

  pauseSong(): void {
    this.node?.send({ type: "pause" });
    this.playing = false;
    this.emit();
  }

  stopAll(): void {
    this.node?.send({ type: "stop" });
    this.playing = false;
    this.position = null;
    this.emit();
  }

  seek(order: number, row: number): void {
    this.node?.send({ order, row, type: "seek" });
  }

  setTempo(tempo: number): void {
    this.tempo = tempo;
    this.node?.send({ tempo, type: "setTempo" });
  }

  setChannel(
    channel: number,
    opts: { muted?: boolean; solo?: boolean; volume?: number; pan?: number }
  ): void {
    this.node?.send({ channel, type: "setChannel", ...opts });
  }

  setMaster(opts: { volume?: number; limiter?: boolean }): void {
    this.node?.send({ type: "setMaster", ...opts });
  }

  /** Seconds into the song, from the engine's position (tempo changes are ignored here). */
  songSeconds(): number {
    const p = this.position;
    if (!p) {
      return 0;
    }
    return (p.pulse * 60) / (this.tempo * 96);
  }

  /* ----- instruments and held notes ----- */

  setInstrument(id: string, inst: Instrument): void {
    if (!this.node) {
      return;
    }
    const key = JSON.stringify(inst);
    if (this.instKeys.get(id) !== key) {
      this.instKeys.set(id, key);
      this.node.send({ id, instrument: inst, type: "setInstrument" });
    }
  }

  previewChannelFor(kind: string): number {
    const i = PREVIEW_KINDS.indexOf(kind as (typeof PREVIEW_KINDS)[number]);
    return Math.max(0, i);
  }

  /** Hold a note on an instrument with no song around (the keyboard in the instrument view). */
  previewNoteOn(
    id: string,
    inst: Instrument,
    note: number,
    velocity = 0.9
  ): number {
    if (!this.node) {
      return -1;
    }
    // the preview channels exist only while no song is loaded
    this.unloadSong();
    this.setInstrument(id, inst);
    const channel = this.previewChannelFor(inst.kind);
    this.node.send({ channel, instrument: id, note, type: "noteOn", velocity });
    return channel;
  }

  /** Hold a note through a channel of the loaded song, with an instrument of the project: the song stays loaded. */
  songNoteOn(
    channel: number,
    id: string,
    inst: Instrument,
    note: number,
    velocity = 0.9
  ): void {
    this.setInstrument(id, inst);
    this.noteOn(channel, note, velocity, id);
  }

  noteOn(
    channel: number,
    note: number,
    velocity: number,
    instrument?: string
  ): void {
    this.node?.send({
      channel,
      note,
      type: "noteOn",
      velocity,
      ...(instrument ? { instrument } : {}),
    });
  }

  noteOff(channel: number): void {
    this.node?.send({ channel, type: "noteOff" });
  }

  dispose(): void {
    this.offNode?.();
    this.node?.dispose();
    if (this.ctx) {
      fire(this.ctx.close());
    }
  }
}

export const engine = new Engine();
