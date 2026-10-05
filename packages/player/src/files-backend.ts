/* Files mode: rendered audio files played through AudioBufferSourceNodes. Sfx are capped per id and overall, music
   loops seamlessly on the source's own loop points, and note events are replayed from the `.events.json` file. */

import { playRamp } from "./audio-graph.ts";
import { EventReplayer, parseEventsFile } from "./event-replay.ts";
import { joinUrl, OGG_ADVICE, supportsOgg } from "./manifest.ts";
import {
  type LoopPlan,
  planLoop,
  type Ramp,
  rampLevel,
  semitonesToRate,
  startOffset,
} from "./schedule.ts";
import type { BackendShared } from "./shared.ts";
import type {
  MusicOptions,
  PlayerEvent,
  SfxHandle,
  SfxOptions,
  SongHandle,
} from "./types.ts";
import { clamp } from "./util.ts";
import { VoiceCap } from "./voice-cap.ts";

/** A sound effect that finished loading later than this after it was asked for is not played any more. */
const LATE_SFX_SECONDS = 1;
/** Fade used to cut a voice short without a click. */
const QUICK_FADE = 0.008;

interface SfxVoice {
  gain: GainNode;
  id: string;
  panner: StereoPannerNode | null;
  source: AudioBufferSourceNode;
}

interface MusicVoice {
  gain: GainNode;
  id: string;
  ramp: Ramp;
  row: { order: number; row: number } | null;
  source: AudioBufferSourceNode;
  stopped: boolean;
}

export interface FilesOptions {
  maxInstancesPerSfx: number;
  maxSfxVoices: number;
}

function inertSfx(id: string, handle: number): SfxHandle {
  return {
    handle,
    id,
    stop() {
      // nothing is playing
    },
  };
}

function inertSong(id: string): SongHandle {
  return {
    id,
    position: () => null,
    stop() {
      // nothing is playing
    },
  };
}

export class FilesBackend {
  private readonly s: BackendShared;
  private readonly cap: VoiceCap<SfxVoice>;
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private readonly ready = new Map<string, AudioBuffer>();
  private readonly eventFiles = new Map<
    string,
    Promise<ReturnType<typeof parseEventsFile>>
  >();
  private current: MusicVoice | null = null;
  private token = 0;
  private disposed = false;

  constructor(shared: BackendShared, opts: FilesOptions) {
    this.s = shared;
    this.cap = new VoiceCap<SfxVoice>({
      perId: opts.maxInstancesPerSfx,
      total: opts.maxSfxVoices,
    });
  }

  /* ---------- loading ---------- */

  private async fetchBuffer(key: string, file: string): Promise<AudioBuffer> {
    const url = joinUrl(this.s.manifest.base, file);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`could not load ${url}: ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    try {
      return await this.s.ctx.decodeAudioData(bytes);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const ogg = file.toLowerCase().endsWith(".ogg") && !supportsOgg();
      throw new Error(
        `could not decode ${key} (${file}): ${ogg ? OGG_ADVICE : reason}`,
        { cause: error }
      );
    }
  }

  private load(kind: "sfx" | "songs", id: string): Promise<AudioBuffer> {
    const key = `${kind}:${id}`;
    const cached = this.buffers.get(key);
    if (cached) {
      return cached;
    }
    const entry = this.s.manifest[kind][id];
    if (!entry) {
      return Promise.reject(new Error(`unknown ${kind} "${id}"`));
    }
    const promise = this.fetchBuffer(key, entry.file).then((buffer) => {
      this.ready.set(key, buffer);
      return buffer;
    });
    this.buffers.set(key, promise);
    promise.catch(() => this.buffers.delete(key));
    return promise;
  }

  private loadEvents(id: string, rate: number) {
    const cached = this.eventFiles.get(id);
    if (cached) {
      return cached;
    }
    const path = this.s.manifest.songs[id]?.events;
    const promise = path
      ? fetch(joinUrl(this.s.manifest.base, path))
          .then((r) => (r.ok ? r.json() : null))
          .then((json) => parseEventsFile(json, rate))
          .catch(() => null)
      : Promise.resolve(null);
    this.eventFiles.set(id, promise);
    return promise;
  }

  async preload(ids?: string[]): Promise<void> {
    const { sfx, songs } = this.s.manifest;
    const jobs: Promise<unknown>[] = [];
    for (const id of ids ?? [...Object.keys(sfx), ...Object.keys(songs)]) {
      if (id in sfx) {
        jobs.push(this.load("sfx", id));
      }
      if (id in songs) {
        jobs.push(this.load("songs", id));
        jobs.push(this.loadEvents(id, this.s.manifest.sampleRate));
      }
    }
    await Promise.all(jobs);
  }

  /* ---------- sfx ---------- */

  sfx(id: string, opts: SfxOptions = {}): SfxHandle {
    const handle = this.s.nextHandle();
    if (!this.s.manifest.sfx[id]) {
      this.s.report(new Error(`unknown sfx "${id}"`));
      return inertSfx(id, handle);
    }
    let voice: SfxVoice | null = null;
    let stopped = false;
    const asked = this.s.ctx.currentTime;
    const begin = (loaded: AudioBuffer) => {
      if (!(stopped || this.disposed)) {
        voice = this.startSfx(id, loaded, opts);
      }
    };
    const buffer = this.ready.get(`sfx:${id}`);
    if (buffer) {
      begin(buffer);
    } else {
      this.load("sfx", id)
        .then((b) => {
          if (this.s.ctx.currentTime - asked <= LATE_SFX_SECONDS) {
            begin(b);
          }
        })
        .catch((error) => this.s.report(error));
    }
    return {
      handle,
      id,
      stop: () => {
        stopped = true;
        if (voice) {
          this.cut(voice);
        }
      },
    };
  }

  private startSfx(
    id: string,
    buffer: AudioBuffer,
    opts: SfxOptions
  ): SfxVoice {
    const { ctx } = this.s;
    for (const old of this.cap.evictFor(id)) {
      this.cut(old, false);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = semitonesToRate(opts.pitch ?? 0);
    source.loop = opts.loop === true;
    const gain = ctx.createGain();
    const velocity = clamp(opts.velocity ?? 1, 0, 1);
    gain.gain.value = velocity;
    const pan = clamp(opts.pan ?? 0, -1, 1);
    const panner =
      pan !== 0 && typeof ctx.createStereoPanner === "function"
        ? ctx.createStereoPanner()
        : null;
    source.connect(gain);
    if (panner) {
      panner.pan.value = pan;
      gain.connect(panner);
      panner.connect(this.s.sfxBus);
    } else {
      gain.connect(this.s.sfxBus);
    }
    const voice: SfxVoice = { gain, id, panner, source };
    source.onended = () => {
      this.cap.remove(voice);
      source.disconnect();
      gain.disconnect();
      panner?.disconnect();
    };
    this.cap.add(id, voice);
    source.start();
    this.announce(id, velocity);
    return voice;
  }

  private announce(id: string, velocity: number): void {
    if (!this.s.dispatcher.wants("trigger")) {
      return;
    }
    const time = this.s.ctx.currentTime + this.s.latency();
    this.s.dispatcher.push({
      channel: -1,
      channelId: "",
      frame: Math.round(time * this.s.ctx.sampleRate),
      hz: 0,
      id,
      note: 0,
      order: -1,
      row: -1,
      time,
      type: "trigger",
      velocity,
    });
    this.s.wake();
  }

  /** Stop an sfx voice with a quick fade (forget it first when `forget` is true). */
  private cut(voice: SfxVoice, forget = true): void {
    if (forget) {
      this.cap.remove(voice);
    }
    const now = this.s.ctx.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + QUICK_FADE);
    try {
      voice.source.stop(now + QUICK_FADE + 0.002);
    } catch {
      // already stopped
    }
  }

  /* ---------- music ---------- */

  async music(id: string, opts: MusicOptions = {}): Promise<SongHandle> {
    const entry = this.s.manifest.songs[id];
    if (!entry) {
      this.s.report(new Error(`unknown song "${id}"`));
      return inertSong(id);
    }
    this.token += 1;
    const { token } = this;
    let buffer: AudioBuffer;
    let events: Awaited<ReturnType<FilesBackend["loadEvents"]>>;
    try {
      [buffer, events] = await Promise.all([
        this.load("songs", id),
        this.loadEvents(id, this.s.manifest.sampleRate),
      ]);
    } catch (error) {
      this.s.report(error instanceof Error ? error : new Error(String(error)));
      return inertSong(id);
    }
    if (token !== this.token || this.disposed) {
      return inertSong(id);
    }

    const { ctx } = this.s;
    const fadeIn = Math.max(0, opts.fadeIn ?? 0);
    this.stopCurrent(fadeIn);

    const plan = planLoop(entry, buffer.duration, opts.loop);
    const offset = startOffset(opts.startAt, plan, buffer.duration);
    const startTime = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    this.applyLoop(source, plan);
    const gain = ctx.createGain();
    const ramp: Ramp = {
      duration: fadeIn,
      from: fadeIn > 0 ? 0 : 1,
      start: startTime,
      to: 1,
    };
    playRamp(gain.gain, ramp);
    source.connect(gain);
    gain.connect(this.s.musicBus);
    const voice: MusicVoice = {
      gain,
      id,
      ramp,
      row: null,
      source,
      stopped: false,
    };
    this.current = voice;
    source.onended = () => {
      if (this.current === voice) {
        this.current = null;
      }
      source.disconnect();
      gain.disconnect();
    };
    source.start(startTime, offset);

    if (events) {
      const replayer = new EventReplayer(events, plan, {
        contextRate: ctx.sampleRate,
        duration: buffer.duration,
        latency: this.s.latency(),
        offset,
        startTime,
      });
      this.s.addPumper((now) => this.pump(voice, replayer, now));
      this.s.wake();
    }
    return this.handleFor(voice);
  }

  private applyLoop(source: AudioBufferSourceNode, plan: LoopPlan): void {
    source.loop = plan.loop;
    if (plan.loop) {
      source.loopStart = plan.loopStart;
      source.loopEnd = plan.loopEnd;
    }
  }

  private pump(voice: MusicVoice, replayer: EventReplayer, now: number) {
    if (voice.stopped) {
      return false;
    }
    const events: PlayerEvent[] = replayer.collect(now);
    for (const e of events) {
      if (e.type === "row") {
        voice.row = { order: e.order, row: e.row };
      }
      this.s.dispatcher.push(e);
    }
    return !replayer.done;
  }

  private handleFor(voice: MusicVoice): SongHandle {
    return {
      id: voice.id,
      position: () =>
        voice.stopped || !voice.row
          ? null
          : { order: voice.row.order, pulse: -1, row: voice.row.row, tick: 0 },
      stop: (opts) => {
        if (this.current === voice) {
          this.stopCurrent(opts?.fadeOut ?? 0);
        }
      },
    };
  }

  /** Fade the current song out and stop it. */
  private stopCurrent(fadeOut: number): void {
    const voice = this.current;
    if (!voice) {
      return;
    }
    this.current = null;
    voice.stopped = true;
    const now = this.s.ctx.currentTime;
    const seconds = Math.max(fadeOut, QUICK_FADE);
    const from = rampLevel(voice.ramp, now);
    voice.ramp = { duration: seconds, from, start: now, to: 0 };
    playRamp(voice.gain.gain, voice.ramp);
    try {
      voice.source.stop(now + seconds + 0.01);
    } catch {
      // already stopped
    }
  }

  stopMusic(opts?: { fadeOut?: number }): void {
    this.token += 1;
    this.stopCurrent(opts?.fadeOut ?? 0);
  }

  dispose(): void {
    this.disposed = true;
    this.token += 1;
    this.stopCurrent(0);
    for (const voice of this.cap.clear()) {
      this.cut(voice, false);
    }
  }
}
