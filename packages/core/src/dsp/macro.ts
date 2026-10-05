/* Famitracker style macros: one value per engine tick, with a loop index and a release index (section 3.4). */

import type { Macro } from "../types.ts";

export interface MacroRt {
  idx: number;
  loop: number;
  present: boolean;
  release: number;
  released: boolean;
  value: number;
  values: Float32Array;
}

export function newMacroRt(): MacroRt {
  return {
    idx: 0,
    loop: -1,
    present: false,
    release: -1,
    released: false,
    value: 0,
    values: new Float32Array(1),
  };
}

export function compileMacro(m: Macro | undefined): MacroRt {
  const rt = newMacroRt();
  if (m && m.values.length > 0) {
    rt.values = Float32Array.from(m.values);
    rt.loop = m.loop;
    rt.release = m.release;
    rt.value = rt.values[0] ?? 0;
    rt.present = true;
  }
  return rt;
}

/** Point a per-voice runtime at a compiled macro (the values array is shared and never mutated). */
export function macroBind(dst: MacroRt, src: MacroRt): void {
  dst.values = src.values;
  dst.loop = src.loop;
  dst.release = src.release;
  dst.present = src.present;
  dst.idx = 0;
  dst.value = src.values[0] ?? 0;
  dst.released = false;
}

/** Begin a note: the first value applies at once. */
export function macroStart(m: MacroRt): void {
  m.idx = 0;
  m.released = false;
  m.value = m.values[0] ?? 0;
}

/** Note release: jump to the release index when there is one. */
export function macroRelease(m: MacroRt): void {
  if (m.released) {
    return;
  }
  m.released = true;
  if (m.release >= 0 && m.release < m.values.length) {
    m.idx = m.release;
    m.value = m.values[m.idx] ?? 0;
  }
}

/** One tick later: the next value, looping or holding the last. */
export function macroTick(m: MacroRt): void {
  const len = m.values.length;
  m.idx += 1;
  if (m.idx >= len) {
    const looping = m.loop >= 0 && !(m.released && m.release >= 0);
    m.idx = looping ? m.loop : len - 1;
  }
  m.value = m.values[m.idx] ?? 0;
}

/** Live edit: keep the position when the new macro is at least as long, else clamp it. */
export function macroCarryOver(next: MacroRt, prev: MacroRt): void {
  next.released = prev.released;
  next.idx =
    prev.idx < next.values.length
      ? prev.idx
      : Math.max(0, next.values.length - 1);
  next.value = next.values[next.idx] ?? 0;
}
