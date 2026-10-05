/* createPlayer: the game-facing API (section 5.5). It owns the AudioContext graph (sfx and music buses into a master
   gain), picks files or synth per sound, and runs the timer that delivers events when they become audible. */

import { createContext, rampParam, unlockOnGesture } from "./audio-graph.ts";
import { EventDispatcher } from "./dispatcher.ts";
import { contextLatency } from "./engine-node.ts";
import { FilesBackend } from "./files-backend.ts";
import { OGG_ADVICE, supportsOgg, undecodableFiles } from "./manifest.ts";
import type { BackendShared } from "./shared.ts";
import { SynthBackend } from "./synth-backend.ts";
import type {
  AudioManifest,
  BleepPlayer,
  MusicOptions,
  PlayerBus,
  PlayerOptions,
  SfxHandle,
  SfxOptions,
  SongHandle,
} from "./types.ts";
import { clamp } from "./util.ts";

/** How often queued events are checked against the audio clock. */
const PUMP_MS = 10;
/** Ramp applied to bus volume changes without an explicit time, so they do not click. */
const DEFAULT_RAMP = 0.01;

const EMPTY_MANIFEST: AudioManifest = {
  base: "/",
  sampleRate: 48_000,
  sfx: {},
  songs: {},
};

function warnToConsole(error: Error): void {
  console.warn(`bleepkit: ${error.message}`);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Master, sfx and music gains: sfx and music feed master, master feeds the speakers. */
function buildBuses(ctx: AudioContext, initial: PlayerOptions["buses"]) {
  const master = ctx.createGain();
  const sfx = ctx.createGain();
  const music = ctx.createGain();
  const gains: Record<PlayerBus, GainNode> = { master, music, sfx };
  const volumes: Record<PlayerBus, number> = {
    master: clamp(initial?.master ?? 1, 0, 1),
    music: clamp(initial?.music ?? 1, 0, 1),
    sfx: clamp(initial?.sfx ?? 1, 0, 1),
  };
  for (const bus of ["master", "music", "sfx"] as const) {
    gains[bus].gain.value = volumes[bus];
  }
  gains.sfx.connect(gains.master);
  gains.music.connect(gains.master);
  gains.master.connect(ctx.destination);
  return { gains, volumes };
}

/** One timer for everything that must happen when the audio clock gets somewhere: replayed note events and the
    delivery of queued events. It runs only while there is something to deliver. */
function createPump(ctx: AudioContext, dispatcher: EventDispatcher) {
  const pumpers = new Set<(now: number) => boolean>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const tick = () => {
    const now = ctx.currentTime;
    for (const fn of [...pumpers]) {
      if (!fn(now)) {
        pumpers.delete(fn);
      }
    }
    dispatcher.flush(now);
    if (pumpers.size === 0 && dispatcher.pending === 0) {
      stop();
    }
  };
  return {
    addPumper: (fn: (now: number) => boolean) => {
      pumpers.add(fn);
    },
    dispose: () => {
      pumpers.clear();
      stop();
    },
    wake: () => {
      timer ??= setInterval(tick, PUMP_MS);
    },
  };
}

/** The synth backend when the manifest embeds documents (and the mode allows it), else null. */
async function startSynth(
  shared: BackendShared,
  opts: PlayerOptions
): Promise<SynthBackend | null> {
  const { manifest, report } = shared;
  const mode = opts.mode ?? "auto";
  const sfx = Object.values(manifest.sfx).some((e) => e.data);
  const songs = Object.values(manifest.songs).some((e) => e.data);
  if (mode === "files") {
    return null;
  }
  if (!(sfx || songs)) {
    if (mode === "synth") {
      report(
        new Error(
          'mode is "synth" but the manifest embeds no documents (export with embed: true); using files'
        )
      );
    }
    return null;
  }
  const synth = new SynthBackend(shared);
  try {
    await synth.init({
      maxSfxVoices: opts.maxSfxVoices ?? 8,
      needMusic: songs,
      needSfx: sfx,
      ...(opts.workletUrl === undefined ? {} : { workletUrl: opts.workletUrl }),
    });
    return synth;
  } catch (error) {
    synth.dispose();
    report(toError(error));
    return null;
  }
}

/** Create a player. Pass the `manifest` from your generated audio.ts and the ids become typed. */
export async function createPlayer<M extends AudioManifest = AudioManifest>(
  opts: PlayerOptions<M> = {}
): Promise<BleepPlayer<keyof M["sfx"] & string, keyof M["songs"] & string>> {
  const manifest: AudioManifest = opts.manifest ?? EMPTY_MANIFEST;
  const report = opts.onError ?? warnToConsole;
  const ownsContext = opts.context === undefined;
  const ctx = opts.context ?? createContext();
  const { gains, volumes } = buildBuses(ctx, opts.buses);
  const dispatcher = new EventDispatcher(report);
  const pump = createPump(ctx, dispatcher);
  let handles = 0;

  const shared: BackendShared = {
    addPumper: pump.addPumper,
    ctx,
    dispatcher,
    latency: () => contextLatency(ctx),
    manifest,
    musicBus: gains.music,
    nextHandle: () => {
      handles += 1;
      return handles;
    },
    report,
    sfxBus: gains.sfx,
    wake: pump.wake,
  };
  const files = new FilesBackend(shared, {
    maxInstancesPerSfx: opts.maxInstancesPerSfx ?? 4,
    maxSfxVoices: opts.maxSfxVoices ?? 8,
  });
  const synth = await startSynth(shared, opts as PlayerOptions);
  if (synth === null && undecodableFiles(manifest, supportsOgg()).length > 0) {
    report(new Error(OGG_ADVICE));
  }
  const useSynth = (kind: "sfx" | "songs", id: string): boolean =>
    synth?.has(kind, id) ?? false;

  const unlock = opts.unlockOnGesture === false ? null : unlockOnGesture(ctx);
  let muted = false;
  let disposed = false;
  const applyMaster = (ramp: number) => {
    rampParam(
      gains.master.gain,
      muted ? 0 : volumes.master,
      ramp,
      ctx.currentTime
    );
  };

  const player: BleepPlayer = {
    context: ctx,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unlock?.();
      files.dispose();
      synth?.dispose();
      pump.dispose();
      dispatcher.dispose();
      for (const node of Object.values(gains)) {
        node.disconnect();
      }
      if (ownsContext && ctx.state !== "closed") {
        ctx.close().catch(() => undefined);
      }
    },
    music(id, musicOpts?: MusicOptions): Promise<SongHandle> {
      // one song at a time, whichever backend plays it: the other one lets go of its song first
      const fadeOut = musicOpts?.fadeIn ?? 0;
      if (synth && useSynth("songs", id)) {
        files.stopMusic({ fadeOut });
        return synth.music(id, musicOpts);
      }
      synth?.stopMusic({ fadeOut });
      return files.music(id, musicOpts);
    },
    mute(on) {
      muted = on;
      applyMaster(DEFAULT_RAMP);
    },
    on: (type, fn) => dispatcher.on(type, fn),
    async preload(ids) {
      const all = ids ?? [
        ...Object.keys(manifest.sfx),
        ...Object.keys(manifest.songs),
      ];
      const jobs: Promise<void>[] = [];
      const embedded: string[] = [];
      for (const id of all) {
        const kind = id in manifest.sfx ? "sfx" : "songs";
        if (useSynth(kind, id)) {
          embedded.push(id);
        } else {
          jobs.push(files.preload([id]));
        }
      }
      jobs.push(synth?.preload(embedded) ?? Promise.resolve());
      await Promise.all(jobs);
    },
    async resume() {
      if (ctx.state !== "running") {
        await ctx.resume();
      }
    },
    setVolume(bus, v, rampSeconds) {
      volumes[bus] = clamp(v, 0, 1);
      if (bus === "master") {
        applyMaster(rampSeconds ?? DEFAULT_RAMP);
        return;
      }
      rampParam(
        gains[bus].gain,
        volumes[bus],
        rampSeconds ?? DEFAULT_RAMP,
        ctx.currentTime
      );
    },
    sfx(id, sfxOpts?: SfxOptions): SfxHandle {
      return synth && useSynth("sfx", id)
        ? synth.sfx(id, sfxOpts)
        : files.sfx(id, sfxOpts);
    },
    stopMusic(stopOpts) {
      files.stopMusic(stopOpts);
      synth?.stopMusic(stopOpts);
    },
  };
  return player as BleepPlayer<
    keyof M["sfx"] & string,
    keyof M["songs"] & string
  >;
}
