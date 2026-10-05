/* Small Web Audio helpers shared by the backends: parameter ramps, one-time unlock, context creation. */

import type { Ramp } from "./schedule.ts";

/** Ramp a parameter from where it is to `target` over `seconds` (0 sets it at once). */
export function rampParam(
  param: AudioParam,
  target: number,
  seconds: number,
  now: number
): void {
  param.cancelScheduledValues(now);
  if (seconds <= 0) {
    param.setValueAtTime(target, now);
    return;
  }
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(target, now + seconds);
}

/** Run a known ramp on a parameter (the level at its start is explicit, so interrupted fades stay exact). */
export function playRamp(param: AudioParam, ramp: Ramp): void {
  param.cancelScheduledValues(ramp.start);
  param.setValueAtTime(ramp.from, ramp.start);
  if (ramp.duration > 0) {
    param.linearRampToValueAtTime(ramp.to, ramp.start + ramp.duration);
  } else {
    param.setValueAtTime(ramp.to, ramp.start);
  }
}

type ContextConstructor = new (options?: AudioContextOptions) => AudioContext;

export function createContext(): AudioContext {
  const g = globalThis as {
    AudioContext?: ContextConstructor;
    webkitAudioContext?: ContextConstructor;
  };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctor) {
    throw new Error("Web Audio is not available in this environment");
  }
  return new Ctor({ latencyHint: "interactive" });
}

const GESTURES = ["pointerup", "keydown", "touchend", "click"] as const;

/** Resume the context on the first user gesture. Returns the function that removes the listeners. */
export function unlockOnGesture(ctx: AudioContext): () => void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) {
    return () => undefined;
  }
  const remove = () => {
    for (const type of GESTURES) {
      doc.removeEventListener(type, attempt, true);
    }
  };
  function attempt() {
    if (ctx.state === "running") {
      remove();
      return;
    }
    ctx
      .resume()
      .then(() => {
        if (ctx.state === "running") {
          remove();
        }
      })
      .catch(() => undefined);
  }
  for (const type of GESTURES) {
    doc.addEventListener(type, attempt, true);
  }
  return remove;
}
