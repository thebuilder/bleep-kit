/* The playable keyboard under the instrument and sample editors: a two octave piano on a canvas, an octave shift that
   is remembered, the computer keys (the tracker rows), and the keys that light for the notes the engine reports. The
   view owns what a note does (`noteDown` and `noteUp`); this owns the keys. */

import type { EngineEvent } from "../lib/contract.ts";
import { clamp, prefs } from "../lib/dom.ts";
import type { Frame } from "../visuals/loop.ts";
import {
  createPiano,
  keyToOffset,
  LOWER_KEYS,
  type Piano,
  UPPER_KEYS,
} from "./piano.ts";

export interface KeyboardOpts {
  canvas: HTMLCanvasElement;
  /** The color of a lit key, read each time a key lights. */
  color: () => string;
  noteDown: (note: number) => void;
  noteUp: (note: number) => void;
  /** The element that shows the octave number. */
  octaveLabel: HTMLElement;
  /** Whether the engine's noteOn for this preview id is this view's (so its keys light). */
  owns: (previewId: string) => boolean;
}

export interface Keyboard {
  /** The pending computer-key presses are released, the key listener removed and the piano disposed. */
  dispose: () => void;
  /** One animation frame: light the keys of the notes the engine reports, put them out on the matching noteOff, and
      redraw the piano while something is lit or fading. */
  frame: (f: Frame) => void;
  /** The lowest note of the two visible octaves. */
  low: () => number;
  /** Handle a keydown: the octave keys and the piano keys (not with a modifier or a repeat). True when it was one. */
  onKey: (e: KeyboardEvent) => boolean;
  /** The current piano (a new one is made when the octave changes). */
  readonly piano: Piano;
  setOctave: (octave: number) => void;
  /** Move the octave by `by` (clamped to 1..6). */
  shift: (by: number) => void;
}

export function createKeyboard(o: KeyboardOpts): Keyboard {
  let octave = prefs.get("kb-octave", 3);
  const heldKeys = new Map<string, number>();
  const labels = new Map<number, string>();
  const low = () => (octave + 1) * 12;
  const relabel = () => {
    labels.clear();
    for (const [i, c] of (LOWER_KEYS + UPPER_KEYS).split("").entries()) {
      labels.set(low() + i, c.toUpperCase());
    }
  };
  const makePiano = (): Piano =>
    createPiano(o.canvas, {
      hi: low() + 23,
      label: (n) => labels.get(n) ?? null,
      lo: low(),
      onDown: (n) => o.noteDown(n),
      onUp: (n) => o.noteUp(n),
    });
  relabel();
  let piano = makePiano();
  const setOctave = (next: number): void => {
    octave = clamp(next, 1, 6);
    prefs.set("kb-octave", octave);
    o.octaveLabel.textContent = String(octave);
    piano.dispose();
    relabel();
    piano = makePiano();
    piano.draw();
  };
  o.octaveLabel.textContent = String(octave);

  const onKeyUp = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    const n = heldKeys.get(key);
    if (n !== undefined) {
      heldKeys.delete(key);
      o.noteUp(n);
    }
  };
  document.addEventListener("keyup", onKeyUp);

  /** The keys each preview channel lit and has not put out yet. A note is announced twice: at once when it is played,
      and again by the engine when it becomes audible. So the engine's noteOn for an old key can arrive after a newer
      key was lit, and one slot per channel would forget the old key and leave it lit. A channel holds one note, so its
      noteOff puts out every key it lit. */
  const litOn = new Map<number, Set<number>>();

  /** Light a key of the visible octaves and remember which channel lit it. */
  const lightNote = (channel: number, n: number, time: number): void => {
    if (n < low() || n >= low() + 24) {
      return;
    }
    piano.light(n, o.color(), true, time);
    const keys = litOn.get(channel) ?? new Set<number>();
    keys.add(n);
    litOn.set(channel, keys);
  };

  return {
    dispose() {
      document.removeEventListener("keyup", onKeyUp);
      for (const n of heldKeys.values()) {
        o.noteUp(n);
      }
      heldKeys.clear();
      piano.dispose();
    },
    frame(f) {
      for (const ev of f.events as readonly EngineEvent[]) {
        if (ev.channel < 0) {
          continue;
        }
        if (ev.type === "noteOff") {
          for (const n of litOn.get(ev.channel) ?? []) {
            piano.release(n, f.time);
          }
          litOn.delete(ev.channel);
        } else if (ev.type === "noteOn" && o.owns(ev.id)) {
          lightNote(ev.channel, Math.round(ev.note), f.time);
        }
      }
      if (piano.busy(f.time) || f.reduced) {
        piano.draw(f.time);
      }
    },
    low,
    onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) {
        return false;
      }
      if (e.key === "-") {
        setOctave(octave - 1);
        return true;
      }
      if (e.key === "=" || e.key === "+") {
        setOctave(octave + 1);
        return true;
      }
      const off = keyToOffset(e.key);
      if (off === null || e.key.length !== 1 || off >= 24) {
        return false;
      }
      const key = e.key.toLowerCase();
      if (heldKeys.has(key)) {
        return true;
      }
      const n = low() + off;
      heldKeys.set(key, n);
      o.noteDown(n);
      return true;
    },
    get piano() {
      return piano;
    },
    setOctave,
    shift: (by) => setOctave(octave + by),
  };
}
