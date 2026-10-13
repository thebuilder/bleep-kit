/* Hearing a Freesound result at once. A preview is fetched from the studio's own origin, decoded with the browser's
   decoder, made mono and level, and played through the engine (Web Audio, the studio's output, the master scope
   moves), never an <audio> element. Decoded previews are kept for the visit, and the ones just below the selection are
   loaded ahead, so moving down a list with the arrow keys sounds each row as soon as it is selected. */
import { MAX_SECONDS } from "../../server/freesound/protocol.ts";
import type { UserSample } from "../lib/contract.ts";
import {
  mixToMonoChannels,
  normalizePeak,
  parseNoteName,
  sampleFromData,
} from "../lib/core.ts";
import type { FreesoundSound } from "./api.ts";

/** A decoded preview: the audio as the engine plays it, and the mono floats an import starts from. */
export interface LoadedPreview {
  mono: Float32Array;
  rate: number;
  sample: UserSample;
}

export interface PreviewDeps {
  /** Decode an encoded file into channels (the browser's decoder). */
  decode: (
    bytes: Uint8Array,
    name: string
  ) => Promise<{ channels: Float32Array[]; sampleRate: number }>;
  /** The preview's encoded bytes. */
  fetchBytes: (sound: FreesoundSound) => Promise<Uint8Array>;
  /** Start a sample through the studio's output. */
  play: (sample: UserSample) => void;
  stop: () => void;
}

export type PreviewState = "idle" | "loading" | "playing" | "failed";

/** Most previews kept decoded. A few seconds of mono audio each. */
const KEEP = 14;
/** The loudness previews are leveled to, so a quiet recording and a loud one sound alike while browsing. */
const PREVIEW_PEAK = 0.85;

/** The sample the engine plays for a decoded preview. */
function toLoaded(
  sound: FreesoundSound,
  decoded: { channels: Float32Array[]; sampleRate: number }
): LoadedPreview {
  const all = mixToMonoChannels(decoded.channels);
  const mono = normalizePeak(
    all.length > decoded.sampleRate * MAX_SECONDS
      ? all.slice(0, Math.floor(decoded.sampleRate * MAX_SECONDS))
      : all,
    PREVIEW_PEAK
  );
  const base = sound.note ? parseNoteName(sound.note) : null;
  const sample = sampleFromData(mono, decoded.sampleRate, {
    baseNote: base ?? 60,
    name: sound.name.slice(0, 64),
  });
  return { mono, rate: decoded.sampleRate, sample };
}

export class PreviewPlayer {
  private readonly deps: PreviewDeps;
  private readonly cache = new Map<number, Promise<LoadedPreview>>();
  private readonly listeners = new Set<() => void>();
  private ticket = 0;
  /** The sound that was asked for last, and what is happening to it. */
  current: { id: number; state: PreviewState } | null = null;

  constructor(deps: PreviewDeps) {
    this.deps = deps;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(id: number, state: PreviewState): void {
    this.current = { id, state };
    for (const fn of this.listeners) {
      fn();
    }
  }

  /** The decoded preview, from the cache when it was loaded before. A failure is forgotten, so the next try retries. */
  load(sound: FreesoundSound): Promise<LoadedPreview> {
    const known = this.cache.get(sound.id);
    if (known) {
      // most recently used goes last
      this.cache.delete(sound.id);
      this.cache.set(sound.id, known);
      return known;
    }
    const task = this.deps
      .fetchBytes(sound)
      .then((bytes) => this.deps.decode(bytes, `${sound.id}.mp3`))
      .then((decoded) => {
        if (!decoded.channels[0] || decoded.channels[0].length < 2) {
          throw new Error("the preview holds no audio");
        }
        return toLoaded(sound, decoded);
      });
    task.catch(() => this.cache.delete(sound.id));
    this.cache.set(sound.id, task);
    while (this.cache.size > KEEP) {
      this.cache.delete(this.cache.keys().next().value as number);
    }
    return task;
  }

  /** Play `sound` now (again, when it is the same one). Only the newest request is heard when several overlap. */
  async play(sound: FreesoundSound): Promise<void> {
    this.ticket += 1;
    const mine = this.ticket;
    this.set(sound.id, "loading");
    try {
      const loaded = await this.load(sound);
      if (mine !== this.ticket) {
        return;
      }
      this.deps.play(loaded.sample);
      this.set(sound.id, "playing");
    } catch (error) {
      if (mine === this.ticket) {
        this.set(sound.id, "failed");
      }
      throw error;
    }
  }

  /** Load these ahead of time. Failures are ignored here: playing one retries and reports. */
  prefetch(sounds: readonly FreesoundSound[]): void {
    for (const sound of sounds) {
      this.load(sound).catch(() => undefined);
    }
  }

  stop(): void {
    this.ticket += 1;
    this.deps.stop();
    if (this.current) {
      this.set(this.current.id, "idle");
    }
  }

  /** Forget the decoded audio (the dialog closed). */
  clear(): void {
    this.cache.clear();
  }
}
