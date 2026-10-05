/* Synth mode: the manifest embeds the documents and the AudioWorklet synthesizes them. Sound effects and music run
   on two engine nodes so they keep separate buses; each node is a full synth, created only when the manifest has
   documents for it. */

import { playRamp } from "./audio-graph.ts";
import { createEngineNode, type EngineNode } from "./engine-node.ts";
import { type Ramp, rampLevel, secondsToPosition } from "./schedule.ts";
import type { BackendShared } from "./shared.ts";
import type {
  MusicOptions,
  SfxHandle,
  SfxOptions,
  SongHandle,
} from "./types.ts";
import { defined } from "./util.ts";

/** Time a song is faded out before the next one replaces it (one synth plays one song). */
const SWITCH_FADE = 0.04;

export interface SynthBackendOptions {
  maxSfxVoices: number;
  needMusic: boolean;
  needSfx: boolean;
  workletUrl?: string | URL;
}

interface Playing {
  id: string;
  ramp: Ramp;
  token: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SynthBackend {
  private readonly s: BackendShared;
  private sfxEngine: EngineNode | null = null;
  private musicEngine: EngineNode | null = null;
  private musicFade: GainNode | null = null;
  private readonly loaded = new Set<string>();
  private playing: Playing | null = null;
  private token = 0;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(shared: BackendShared) {
    this.s = shared;
  }

  /** Create the engine nodes. Rejects when the worklet cannot be loaded. */
  async init(opts: SynthBackendOptions): Promise<void> {
    const base = defined({ scopes: false, workletUrl: opts.workletUrl });
    if (opts.needSfx) {
      const engine = await createEngineNode(this.s.ctx, {
        ...base,
        sfxVoices: opts.maxSfxVoices,
      });
      engine.node.connect(this.s.sfxBus);
      this.attach(engine);
      this.sfxEngine = engine;
    }
    if (opts.needMusic) {
      const engine = await createEngineNode(this.s.ctx, base);
      const fade = this.s.ctx.createGain();
      engine.node.connect(fade);
      fade.connect(this.s.musicBus);
      this.attach(engine);
      this.musicEngine = engine;
      this.musicFade = fade;
    }
  }

  private attach(engine: EngineNode): void {
    this.unsubscribe.push(
      engine.on((msg) => {
        if (msg.type === "events") {
          for (const e of msg.events) {
            this.s.dispatcher.push({
              ...e,
              time: engine.frameToTime(e.frame, msg),
            });
          }
          this.s.wake();
        } else if (msg.type === "error") {
          this.s.report(new Error(`worklet: ${msg.message}`));
        } else if (msg.type === "ended" && engine === this.musicEngine) {
          this.playing = null;
        }
      })
    );
  }

  has(kind: "sfx" | "songs", id: string): boolean {
    const entry = this.s.manifest[kind][id];
    return (
      Boolean(entry?.data) &&
      (kind === "sfx" ? this.sfxEngine : this.musicEngine) !== null
    );
  }

  /* ---------- sfx ---------- */

  private ensureSfx(engine: EngineNode, id: string): boolean {
    if (this.loaded.has(id)) {
      return true;
    }
    const data = this.s.manifest.sfx[id]?.data;
    if (!data) {
      return false;
    }
    engine.send({ id, sfx: data, type: "loadSfx" });
    this.loaded.add(id);
    return true;
  }

  sfx(id: string, opts: SfxOptions = {}): SfxHandle {
    const handle = this.s.nextHandle();
    const engine = this.sfxEngine;
    if (!(engine && this.ensureSfx(engine, id))) {
      this.s.report(new Error(`no embedded document for sfx "${id}"`));
      return { handle, id, stop: () => undefined };
    }
    engine.send({
      handle,
      id,
      type: "trigger",
      ...defined({
        pan: opts.pan,
        pitch: opts.pitch,
        velocity: opts.velocity,
      }),
    });
    return { handle, id, stop: () => engine.send({ handle, type: "release" }) };
  }

  preload(ids?: string[]): Promise<void> {
    const engine = this.sfxEngine;
    if (engine) {
      for (const id of ids ?? Object.keys(this.s.manifest.sfx)) {
        if (id in this.s.manifest.sfx) {
          this.ensureSfx(engine, id);
        }
      }
    }
    return Promise.resolve();
  }

  /* ---------- music ---------- */

  async music(id: string, opts: MusicOptions = {}): Promise<SongHandle> {
    const engine = this.musicEngine;
    const fade = this.musicFade;
    const data = this.s.manifest.songs[id]?.data;
    const inert: SongHandle = {
      id,
      position: () => null,
      stop: () => undefined,
    };
    if (!(engine && fade && data)) {
      this.s.report(new Error(`no embedded document for song "${id}"`));
      return inert;
    }
    this.token += 1;
    const { token } = this;
    if (this.playing) {
      this.fadeAndStop(engine, fade, SWITCH_FADE);
      await sleep(SWITCH_FADE * 1000 + 10);
      if (token !== this.token) {
        return inert;
      }
    }
    const { ctx } = this.s;
    const fadeIn = Math.max(0, opts.fadeIn ?? 0);
    const ramp: Ramp = {
      duration: fadeIn,
      from: fadeIn > 0 ? 0 : 1,
      start: ctx.currentTime,
      to: 1,
    };
    playRamp(fade.gain, ramp);
    engine.send({
      instruments: data.instruments,
      song: data.song,
      type: "loadSong",
    });
    const start =
      opts.startAt !== undefined && opts.startAt > 0
        ? secondsToPosition(data.song, opts.startAt)
        : {};
    engine.send({
      type: "play",
      ...start,
      loop: opts.loop ?? data.song.loop !== null,
    });
    const playing: Playing = { id, ramp, token };
    this.playing = playing;
    return {
      id,
      position: () =>
        this.playing === playing
          ? (engine.lastClock()?.position ?? null)
          : null,
      stop: (stopOpts) => {
        if (this.playing === playing) {
          this.fadeAndStop(engine, fade, stopOpts?.fadeOut ?? 0);
        }
      },
    };
  }

  private fadeAndStop(
    engine: EngineNode,
    fade: GainNode,
    fadeOut: number
  ): void {
    const { playing } = this;
    if (!playing) {
      return;
    }
    this.playing = null;
    const now = this.s.ctx.currentTime;
    const seconds = Math.max(fadeOut, 0.015);
    const from = rampLevel(playing.ramp, now);
    playRamp(fade.gain, { duration: seconds, from, start: now, to: 0 });
    const { token } = this;
    setTimeout(
      () => {
        // a newer song may already have been loaded: only stop the one that faded out
        if (this.token === token && this.playing === null) {
          engine.send({ type: "stop" });
        }
      },
      seconds * 1000 + 10
    );
  }

  stopMusic(opts?: { fadeOut?: number }): void {
    const engine = this.musicEngine;
    const fade = this.musicFade;
    if (engine && fade) {
      this.fadeAndStop(engine, fade, opts?.fadeOut ?? 0);
    }
  }

  dispose(): void {
    for (const off of this.unsubscribe) {
      off();
    }
    this.sfxEngine?.dispose();
    this.musicEngine?.dispose();
    this.musicFade?.disconnect();
    this.sfxEngine = null;
    this.musicEngine = null;
  }
}
