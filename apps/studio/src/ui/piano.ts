/* A pixel-art piano on a canvas: it lights keys (with a 150 ms fade after release), takes mouse and touch input, and
   labels the keys. The song view uses it as a small read-only strip, the instrument view as a playable keyboard. */

import { choose } from "../lib/dom.ts";
import { rgba, type Surface, surface } from "../visuals/canvas.ts";

const isBlack = (n: number) => [1, 3, 6, 8, 10].includes(n % 12);
const FADE_MS = 150;

interface Lit {
  color: string;
  held: boolean;
  off: number;
  on: boolean;
}

export interface PianoOpts {
  hi: number;
  /** text on a key (the computer key, or the octave number on every C) */
  label?: (note: number) => string | null;
  /** first and last note shown; lo should be a C and hi a B */
  lo: number;
  onDown?: (note: number) => void;
  onUp?: (note: number) => void;
}

export interface Piano {
  /** true while something is lit or fading (the owner can skip drawing otherwise) */
  busy: (now?: number) => boolean;
  clear: () => void;
  dispose: () => void;
  draw: (now?: number) => void;
  /** light a key; `on` true until release() */
  light: (note: number, color: string, on?: boolean, now?: number) => void;
  release: (note: number, now?: number) => void;
  surface: Surface;
}

export function createPiano(canvas: HTMLCanvasElement, o: PianoOpts): Piano {
  const s = surface(canvas);
  const lit = new Map<number, Lit>();
  const whites: number[] = [];
  for (let n = o.lo; n <= o.hi; n += 1) {
    if (!isBlack(n)) {
      whites.push(n);
    }
  }
  const geometry = (note: number) => {
    const ww = s.w / whites.length;
    if (!isBlack(note)) {
      const i = whites.indexOf(note);
      return { black: false, h: s.h, w: ww, x: i * ww };
    }
    const i = whites.indexOf(note - 1);
    const bw = Math.max(5, ww * 0.62);
    return {
      black: true,
      h: Math.round(s.h * 0.6),
      w: bw,
      x: (i + 1) * ww - bw / 2,
    };
  };
  const noteAt = (px: number, py: number): number | null => {
    // black keys sit on top, so test them first
    for (let n = o.lo; n <= o.hi; n += 1) {
      if (isBlack(n)) {
        const g = geometry(n);
        if (px >= g.x && px < g.x + g.w && py < g.h) {
          return n;
        }
      }
    }
    for (const n of whites) {
      const g = geometry(n);
      if (px >= g.x && px < g.x + g.w) {
        return n;
      }
    }
    return null;
  };

  const drawKey = (n: number, now: number) => {
    const { ctx } = s;
    const g = geometry(n);
    const l = lit.get(n);
    let a = 0;
    if (l) {
      a = l.on ? 1 : Math.max(0, 1 - (now - l.off) / FADE_MS);
    }
    const x = Math.round(g.x);
    const w = Math.max(1, Math.round(g.x + g.w) - x);
    const press = l?.held ? 2 : 0;
    if (g.black) {
      ctx.fillStyle = "#0b0a10";
      ctx.fillRect(x, 0, w, g.h);
      ctx.fillStyle = "#2a2838";
      ctx.fillRect(x + 1, 0, w - 2, g.h - 5 + press);
      if (a > 0 && l) {
        ctx.fillStyle = rgba(l.color, 0.25 + 0.75 * a);
        ctx.fillRect(x + 1, 0, w - 2, g.h - 5 + press);
      }
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.fillRect(x + 1, 0, 1, g.h - 5 + press);
    } else {
      ctx.fillStyle = "#0b0a10";
      ctx.fillRect(x, 0, w, g.h);
      ctx.fillStyle = "#e6e0d2";
      ctx.fillRect(x + 1, 0, w - 2, g.h - 1 - press);
      ctx.fillStyle = "#b9b3c4";
      ctx.fillRect(x + 1, g.h - 5 - press, w - 2, 4);
      if (a > 0 && l) {
        ctx.fillStyle = rgba(l.color, 0.2 + 0.8 * a);
        ctx.fillRect(x + 1, 0, w - 2, g.h - 1 - press);
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.fillRect(x + 1, g.h - 5 - press, w - 2, 1);
      }
    }
    const text = o.label?.(n);
    if (text) {
      ctx.font = g.black
        ? '9px "JetBrains Mono", monospace'
        : '10px "JetBrains Mono", monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = choose(
        [
          [g.black, "rgba(236,231,218,0.8)"],
          [a > 0.5, "#1b1306"],
        ],
        "#5b566a"
      );
      ctx.fillText(text, x + w / 2, g.black ? g.h - 10 : g.h - 8);
    }
  };

  let stopInput: () => void = () => undefined;
  const piano: Piano = {
    busy(now = performance.now()) {
      for (const l of lit.values()) {
        if (l.on || now - l.off < FADE_MS + 40) {
          return true;
        }
      }
      return false;
    },
    clear() {
      lit.clear();
    },
    dispose() {
      stopInput();
      s.dispose();
    },
    draw(now = performance.now()) {
      s.fit();
      const { ctx } = s;
      ctx.clearRect(0, 0, s.w, s.h);
      for (const n of whites) {
        drawKey(n, now);
      }
      for (let n = o.lo; n <= o.hi; n += 1) {
        if (isBlack(n)) {
          drawKey(n, now);
        }
      }
      for (const [n, l] of lit) {
        if (!l.on && now - l.off > FADE_MS + 40) {
          lit.delete(n);
        }
      }
    },
    light(note, color, on = true, now = performance.now()) {
      lit.set(note, {
        color,
        held: lit.get(note)?.held ?? false,
        off: on ? 0 : now,
        on,
      });
    },
    release(note, now = performance.now()) {
      const l = lit.get(note);
      if (l) {
        l.on = false;
        l.held = false;
        l.off = now;
      }
    },
    surface: s,
  };

  if (o.onDown) {
    /* One note per pointer (a second finger plays its own). Everything that can end a pointer ends its note: up,
       cancel, a lost capture, the pointer leaving while it is not captured, a move that reports no button (the
       button came up where the page could not hear it), a context menu, the window losing focus and dispose. */
    const down = new Map<number, number>();
    const pos = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return noteAt(e.clientX - r.left, e.clientY - r.top);
    };
    const holdsKey = (n: number) => [...down.values()].includes(n);
    const end = (pointerId: number) => {
      const n = down.get(pointerId);
      if (n === undefined) {
        return;
      }
      down.delete(pointerId);
      const l = lit.get(n);
      if (l && !holdsKey(n)) {
        l.held = false;
      }
      o.onUp?.(n);
    };
    const endAll = () => {
      for (const id of [...down.keys()]) {
        end(id);
      }
    };
    const start = (pointerId: number, n: number) => {
      down.set(pointerId, n);
      const l = lit.get(n);
      if (l) {
        l.held = true;
      }
      o.onDown?.(n);
      const cur = lit.get(n);
      if (cur) {
        cur.held = true;
      }
    };
    const hasCapture = (id: number) => {
      try {
        return canvas.hasPointerCapture(id);
      } catch {
        return false;
      }
    };
    const stop = new AbortController();
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void
    ) => canvas.addEventListener(type, fn, { signal: stop.signal });
    on("pointerdown", (e) => {
      // only the main button plays: a context menu would swallow the right button's pointerup
      if (e.button > 0) {
        return;
      }
      const n = pos(e);
      if (n === null) {
        return;
      }
      // a pointer that is still down has lost its up: let that note go before the next one starts
      end(e.pointerId);
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // the pointer is already gone: pointerleave ends the note, as it is not captured
      }
      start(e.pointerId, n);
    });
    on("pointermove", (e) => {
      const cur = down.get(e.pointerId);
      if (cur === undefined) {
        return;
      }
      if (!e.buttons) {
        end(e.pointerId);
        return;
      }
      const n = pos(e);
      if (n !== null && n !== cur) {
        end(e.pointerId);
        start(e.pointerId, n);
      }
    });
    on("pointerup", (e) => end(e.pointerId));
    on("pointercancel", (e) => end(e.pointerId));
    on("lostpointercapture", (e) => end(e.pointerId));
    on("pointerleave", (e) => {
      if (!hasCapture(e.pointerId)) {
        end(e.pointerId);
      }
    });
    on("contextmenu", endAll);
    window.addEventListener("blur", endAll, { signal: stop.signal });
    stopInput = () => {
      endAll();
      stop.abort();
    };
  }
  return piano;
}

/* Computer keyboard to piano: the two tracker rows, relative to the C of `octave` (lower row) and the one above it. */
export const LOWER_KEYS = "zsxdcvgbhnjm";
export const UPPER_KEYS = "q2w3er5t6y7u";
const EXTRA_KEYS = "i9o0p";

/** Note offset from the C of the lower octave, or null when the key is not a piano key. */
export function keyToOffset(key: string): number | null {
  const k = key.toLowerCase();
  let i = LOWER_KEYS.indexOf(k);
  if (i >= 0) {
    return i;
  }
  i = UPPER_KEYS.indexOf(k);
  if (i >= 0) {
    return 12 + i;
  }
  i = EXTRA_KEYS.indexOf(k);
  return i >= 0 ? 24 + i : null;
}
