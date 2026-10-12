/* Keeping the sound healthy across the things a page outlives: it is hidden for hours, the machine sleeps, a phone call
   interrupts the audio session, the person plugs in Bluetooth headphones. An AudioContext does not always come back
   from those in a good state (it can keep running at a sample rate the speakers no longer have, which is heard as
   crackling and a wrong pitch until the page is reloaded), so this watches for them and tells the engine to
   - hide: the page is hidden. Nobody draws, so stop collecting events and ask the worklet to stop posting them;
   - show: the page is back. Drop what piled up, get a fresh clock;
   - rebuild: throw the context and the engine node away and make new ones, because the old ones cannot be trusted.
   All the browser's own objects come in through `RecoveryEnv`, so the policy is tested without a browser. */

export type RebuildReason = "closed" | "interrupted" | "sample-rate";

export interface RecoveryHost {
  contextRate: () => number;
  contextState: () => string;
  /** The page is hidden. */
  hide: () => void;
  /** The sample rate a new context would get now (the speakers' own), or null when it cannot be told. */
  probeRate: () => Promise<number | null>;
  rebuild: (reason: RebuildReason) => Promise<void>;
  /** The page is visible again. */
  show: () => void;
}

export interface RecoveryEnv {
  /** `navigator.mediaDevices`: fires `devicechange` when headphones come or go. */
  devices: EventTarget | null;
  doc: Document;
  now: () => number;
  win: EventTarget;
}

export interface Recovery {
  dispose: () => void;
  /** Tell it the context's new state (the engine's `statechange` listener calls this). */
  onContextState: (state: string) => void;
  /** A new context took the old one's place, in `state`: what it knew of the old one no longer applies. */
  reset: (state: string) => void;
}

/** A page hidden at least this long checks the speakers' rate when it comes back (ms). */
export const AWAY_CHECK_MS = 5000;
/** A burst of device changes is one change (ms). */
export const DEVICE_SETTLE_MS = 300;
/** Rebuilds closer together than this wait for it (ms): whatever caused the first is being dealt with. It doubles for
 *  each rebuild in a row (up to REBUILD_GAP_MAX_MS), so a cause that cannot be cured never makes the sound cut out
 *  over and over. */
export const REBUILD_GAP_MS = 2000;
export const REBUILD_GAP_MAX_MS = 60_000;
/** Rebuilds this far apart (ms) are not "in a row". */
const CALM_MS = 30_000;

export function watchRecovery(host: RecoveryHost, env: RecoveryEnv): Recovery {
  let hiddenAt: number | null = null;
  let interrupted = false;
  let ranBefore = false;
  let previous = host.contextState();
  let busy = false;
  let lastRebuild = Number.NEGATIVE_INFINITY;
  let inARow = 0;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let later: ReturnType<typeof setTimeout> | undefined;

  const stillNeeded = (reason: RebuildReason): boolean =>
    reason === "closed" ? host.contextState() === "closed" : interrupted;

  const rebuildFor = async (reason: RebuildReason): Promise<void> => {
    if (busy) {
      return;
    }
    const since = env.now() - lastRebuild;
    const gap = Math.min(REBUILD_GAP_MAX_MS, REBUILD_GAP_MS * 2 ** inARow);
    if (since < gap) {
      // too soon after the last one: look again when the gap is over, and rebuild then if it is still needed
      if (later === undefined) {
        later = setTimeout(() => {
          later = undefined;
          if (reason === "sample-rate") {
            void checkRate();
          } else if (stillNeeded(reason)) {
            void rebuildFor(reason);
          }
        }, gap - since);
      }
      return;
    }
    busy = true;
    inARow = since > CALM_MS ? 0 : inARow + 1;
    try {
      interrupted = false;
      await host.rebuild(reason);
    } finally {
      busy = false;
      lastRebuild = env.now();
    }
  };

  const checkRate = async (): Promise<void> => {
    const rate = await host.probeRate();
    if (rate !== null && rate !== host.contextRate()) {
      await rebuildFor("sample-rate");
    }
  };

  const comeBack = (away: number): void => {
    host.show();
    const state = host.contextState();
    if (state === "closed") {
      void rebuildFor("closed");
    } else if (interrupted && state === "running") {
      void rebuildFor("interrupted");
    } else if (away >= AWAY_CHECK_MS) {
      void checkRate();
    }
  };

  const onVisibility = (): void => {
    if (env.doc.visibilityState === "hidden") {
      hiddenAt ??= env.now();
      host.hide();
      return;
    }
    const away = hiddenAt === null ? 0 : env.now() - hiddenAt;
    hiddenAt = null;
    comeBack(away);
  };

  // a page restored from the back/forward cache never saw its context change state
  const onPageShow = (event: Event): void => {
    if ((event as { persisted?: boolean }).persisted) {
      comeBack(AWAY_CHECK_MS);
    }
  };

  const onDevices = (): void => {
    clearTimeout(settle);
    settle = setTimeout(() => void checkRate(), DEVICE_SETTLE_MS);
  };

  env.doc.addEventListener("visibilitychange", onVisibility);
  env.win.addEventListener("pageshow", onPageShow);
  env.devices?.addEventListener("devicechange", onDevices);

  return {
    dispose() {
      clearTimeout(settle);
      clearTimeout(later);
      env.doc.removeEventListener("visibilitychange", onVisibility);
      env.win.removeEventListener("pageshow", onPageShow);
      env.devices?.removeEventListener("devicechange", onDevices);
    },
    onContextState(state) {
      const before = previous;
      previous = state;
      if (state === "interrupted") {
        interrupted = true;
      } else if (state === "closed") {
        void rebuildFor("closed");
      } else if (state === "running") {
        if (interrupted) {
          void rebuildFor("interrupted");
        } else if (ranBefore && before === "suspended") {
          void checkRate();
        }
        ranBefore = true;
      }
    },
    reset(state) {
      previous = state;
      ranBefore = false;
      interrupted = false;
    },
  };
}
