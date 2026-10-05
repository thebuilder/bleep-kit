/* Public types of @bleepkit/player. The document, event and manifest shapes come from @bleepkit/core; the player
   adds the options and handles of the game-facing API (section 5.5 of the architecture document). */

import type {
  AudioManifest,
  EngineEvent,
  EngineEventType,
  SongPosition,
} from "@bleepkit/core";

export type {
  AudioManifest,
  ManifestSfx,
  ManifestSong,
} from "@bleepkit/core";

/** How the player produces sound: rendered files, or documents synthesized live in the AudioWorklet. */
export type PlayerMode = "files" | "synth" | "auto";

export type PlayerBus = "sfx" | "music" | "master";

export interface PlayerOptions<M extends AudioManifest = AudioManifest> {
  /** Initial bus volumes, 0 to 1. */
  buses?: { sfx?: number; music?: number; master?: number };
  /** Created on the spot when omitted (it starts suspended until `resume()` or the first user gesture). */
  context?: AudioContext;
  /** The generated `manifest` from `audio.ts`, or the result of `loadManifest`. */
  manifest?: M;
  /** Concurrent instances of one sound effect in files mode, default 4. */
  maxInstancesPerSfx?: number;
  /** Concurrent sound effects, default 8 (files mode: buffer sources, oldest stopped; synth mode: forwarded). */
  maxSfxVoices?: number;
  /** "files" plays rendered files, "synth" sends documents to the worklet, "auto" (default) picks synth when the
      manifest embeds documents and files otherwise. */
  mode?: PlayerMode;
  /** Called with problems that must not stop the game: a missing id, a failed download, a worklet error.
      Defaults to `console.warn`. */
  onError?: (error: Error) => void;
  /** Resume the context on the first pointer, key or touch gesture, default true. */
  unlockOnGesture?: boolean;
  /** URL of the bundled worklet (`import url from "@bleepkit/player/worklet?url"`). Synth mode only. */
  workletUrl?: string | URL;
}

export interface SfxOptions {
  /** Files mode only: repeat until `stop()`. */
  loop?: boolean;
  /** -1 (left) to 1 (right), default 0. */
  pan?: number;
  /** Semitones, default 0. */
  pitch?: number;
  /** 0 to 1, default 1. */
  velocity?: number;
}

export interface MusicOptions {
  /** Seconds, default 0. */
  fadeIn?: number;
  /** Default: loop when the song has a loop section. `true` on a song without one loops the whole song. */
  loop?: boolean;
  /** Offset into the song in seconds, default 0. In synth mode it is converted to a row at the song's tempo. */
  startAt?: number;
}

export interface PlayerEvent extends EngineEvent {
  /** AudioContext time at which the event is audible. Listeners are called at about this time. */
  time: number;
}

export interface SfxHandle {
  readonly handle: number;
  readonly id: string;
  stop: () => void;
}

export interface SongHandle {
  readonly id: string;
  /** Files mode reports order and row from the song's events file (pulse is -1), or null without one. */
  position: () => SongPosition | null;
  stop: (opts?: { fadeOut?: number }) => void;
}

export type PlayerEventType = EngineEventType;

export interface BleepPlayer<
  SfxId extends string = string,
  SongId extends string = string,
> {
  context: AudioContext;
  dispose: () => void;
  music: (id: SongId, opts?: MusicOptions) => Promise<SongHandle>;
  mute: (on: boolean) => void;
  on: (type: PlayerEventType, fn: (e: PlayerEvent) => void) => () => void;
  /** Decode files (files mode) or compile documents (synth mode) up front. All ids when omitted. */
  preload: (ids?: (SfxId | SongId)[]) => Promise<void>;
  /** Call on a user gesture (the player also does it on the first gesture unless `unlockOnGesture` is false). */
  resume: () => Promise<void>;
  setVolume: (bus: PlayerBus, v: number, rampSeconds?: number) => void;
  sfx: (id: SfxId, opts?: SfxOptions) => SfxHandle;
  stopMusic: (opts?: { fadeOut?: number }) => void;
}
