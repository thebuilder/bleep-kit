/* MML parser (section 2.7). Never throws: problems become issues with the character offset in the message. */

import { effectFromByte, parseEffect } from "../normalize/effects.ts";
import type { Effect, Issue, MmlEvent, MmlOptions } from "../types.ts";
import type { Token } from "./lexer.ts";
import { lex } from "./lexer.ts";

export const MML_PATH = "/mml";
const WHOLE_NOTE_PULSES = 384;
/** Lengths whose pulse count is a whole number (divisors of 384 up to 192). */
export const VALID_LENGTHS: readonly number[] = [
  1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192,
];
const SEMITONES: Readonly<Record<string, number>> = {
  a: 9,
  b: 11,
  c: 0,
  d: 2,
  e: 4,
  f: 5,
  g: 7,
};
const MAX_DEPTH = 4;
const FX_SEPARATOR = /[\s,]+/;

export interface MmlParse {
  /** Pulse at which the last note or rest ends. */
  endPulse: number;
  events: MmlEvent[];
  issues: Issue[];
  loopPulse: number | null;
  tempo: number | null;
}

export function dotFactor(dots: number): number {
  return 2 - 2 ** -dots;
}

interface State {
  fx: Effect[];
  gate: number;
  inst: string | null;
  length: number;
  octave: number;
  pan: number;
  pulse: number;
  transpose: number;
  volume: number;
}

export function parseMml(src: string, opts: MmlOptions = {}): MmlParse {
  const lexed = lex(src, MML_PATH);
  const issues: Issue[] = [...lexed.issues];
  const { tokens } = lexed;
  const events: MmlEvent[] = [];
  let loopPulse: number | null = null;
  let tempo: number | null = null;

  const st: State = {
    fx: [],
    gate: 8,
    inst: null,
    length: WHOLE_NOTE_PULSES / (opts.length ?? 8),
    octave: opts.octave ?? 4,
    pan: 8,
    pulse: 0,
    transpose: 0,
    volume: opts.volume ?? 15,
  };

  const err = (message: string): void => {
    issues.push({ message, path: MML_PATH, severity: "error" });
  };
  const warnAt = (message: string): void => {
    issues.push({ message, path: MML_PATH, severity: "warning" });
  };

  let i = 0;
  let end = tokens.length;

  const peek = (): Token | undefined => (i < end ? tokens[i] : undefined);

  const readNumber = (): number | null => {
    const t = peek();
    if (t && t.kind === "num") {
      i += 1;
      return Number(t.text);
    }
    return null;
  };

  const readSigned = (): number | null => {
    const t = peek();
    let sign = 1;
    if (t && (t.kind === "minus" || t.kind === "plus")) {
      sign = t.kind === "minus" ? -1 : 1;
      i += 1;
    }
    const n = readNumber();
    return n === null ? null : sign * n;
  };

  const readDots = (): number => {
    let d = 0;
    while (peek()?.kind === "dot") {
      d += 1;
      i += 1;
    }
    return d;
  };

  const ranged = (
    cmd: string,
    pos: number,
    n: number | null,
    min: number,
    max: number,
    def: number
  ): number => {
    if (n === null) {
      err(`"${cmd}" needs a number from ${min} to ${max} at offset ${pos}`);
      return def;
    }
    if (n < min || n > max) {
      warnAt(
        `"${cmd}${n}" must be ${min} to ${max}, clamped, at offset ${pos}`
      );
      return Math.min(max, Math.max(min, n));
    }
    return n;
  };

  /** Length number plus dots after a note, rest or l command. Returns pulses. */
  const readLength = (pos: number): number => {
    const t = peek();
    let base = st.length;
    if (t && t.kind === "num") {
      i += 1;
      const n = Number(t.text);
      if (VALID_LENGTHS.includes(n)) {
        base = WHOLE_NOTE_PULSES / n;
      } else {
        err(
          `length "${n}" must be one of ${VALID_LENGTHS.join(" ")} at offset ${t.pos}`
        );
      }
    }
    const dots = readDots();
    if (dots > 3) {
      warnAt(`at most 3 dots are supported at offset ${pos}`);
    }
    return base * dotFactor(Math.min(dots, 3));
  };

  const accidental = (): number => {
    const t = peek();
    if (t && (t.kind === "plus" || t.kind === "sharp")) {
      i += 1;
      return 1;
    }
    if (t && t.kind === "minus") {
      i += 1;
      return -1;
    }
    return 0;
  };

  const midiOf = (raw: number, pos: number): number => {
    const n = raw + st.transpose;
    if (n < 0 || n > 127) {
      warnAt(`note ${n} is outside 0 to 127, clamped, at offset ${pos}`);
      return Math.min(127, Math.max(0, n));
    }
    return n;
  };

  /** Parse a note head (letter form or n<midi>) at the current token. Returns the MIDI note, or null on error. */
  const readNoteHead = (t: Token): number | null => {
    if (t.kind !== "word") {
      return null;
    }
    const letter = t.text;
    if (letter === "n") {
      i += 1;
      const m = readNumber();
      if (m === null) {
        err(`"n" needs a MIDI note number at offset ${t.pos}`);
        return null;
      }
      if (m > 127) {
        warnAt(`"n${m}" must be 0 to 127, clamped, at offset ${t.pos}`);
      }
      return midiOf(Math.min(127, m), t.pos);
    }
    const base = SEMITONES[letter];
    if (base === undefined) {
      return null;
    }
    i += 1;
    const acc = accidental();
    return midiOf((st.octave + 1) * 12 + base + acc, t.pos);
  };

  const pushNote = (pulse: number, duration: number, note: number): void => {
    events.push({
      duration,
      fx: st.fx,
      gate: (duration * st.gate) / 8,
      inst: st.inst,
      note,
      pulse,
      type: "note",
      volume: st.volume,
    });
    st.fx = [];
  };

  const handleNote = (t: Token): void => {
    const note = readNoteHead(t);
    if (note === null) {
      return;
    }
    let total = readLength(t.pos);
    // ties: c4&c8 joins durations of the same pitch without a retrigger
    let startPulse = st.pulse;
    let current = note;
    while (peek()?.kind === "tie") {
      const tieTok = peek() as Token;
      i += 1;
      const nt = peek();
      if (
        nt?.kind !== "word" ||
        (nt.text !== "n" && SEMITONES[nt.text] === undefined)
      ) {
        err(`"&" must be followed by a note at offset ${tieTok.pos}`);
        break;
      }
      const next = readNoteHead(nt);
      if (next === null) {
        break;
      }
      const d = readLength(nt.pos);
      if (next === current) {
        total += d;
      } else {
        warnAt(
          `tie joins different pitches, the second note is played as a new note, at offset ${tieTok.pos}`
        );
        pushNote(startPulse, total, current);
        startPulse += total;
        total = d;
        current = next;
      }
    }
    pushNote(startPulse, total, current);
    st.pulse = startPulse + total;
  };

  const handleFx = (t: Token): void => {
    const codes = t.text.split(FX_SEPARATOR).filter((c) => c.length > 0);
    if (codes.length === 0) {
      err(`empty effect braces at offset ${t.pos}`);
      return;
    }
    for (const code of codes) {
      const fx = parseEffect(code);
      if (!fx) {
        err(
          `"${code}" is not an effect code (letter then two hex digits) at offset ${t.pos}`
        );
      } else if (st.fx.length >= 4) {
        warnAt(
          `a note takes at most 4 effects, "${code}" was dropped, at offset ${t.pos}`
        );
      } else {
        st.fx.push(fx);
      }
    }
  };

  const findClose = (open: number): number => {
    let depth = 0;
    for (let k = open; k < end; k += 1) {
      const kind = tokens[k]?.kind;
      if (kind === "lbr") {
        depth += 1;
      } else if (kind === "rbr") {
        depth -= 1;
        if (depth === 0) {
          return k;
        }
      }
    }
    return -1;
  };

  /** `[body]n`: play the body n times (twice without a count). Nested repeats stop at MAX_DEPTH. */
  const handleRepeat = (t: Token, depth: number): void => {
    const close = findClose(i);
    if (close < 0 || close >= end) {
      err(`unclosed "[" at offset ${t.pos}`);
      i += 1;
      return;
    }
    const after = close + 1;
    let count = 2;
    let resume = after;
    const nt = tokens[after];
    if (after < end && nt && nt.kind === "num") {
      count = Number(nt.text);
      resume = after + 1;
    }
    if (count < 1 || count > 255) {
      warnAt(
        `repeat count ${count} must be 1 to 255, clamped, at offset ${t.pos}`
      );
      count = Math.min(255, Math.max(1, count));
    }
    if (depth >= MAX_DEPTH) {
      err(
        `repeats nest at most ${MAX_DEPTH} deep, the inner repeat plays once, at offset ${t.pos}`
      );
      count = 1;
    }
    const bodyFrom = i + 1;
    for (let rep = 0; rep < count; rep += 1) {
      run(bodyFrom, close, depth + 1);
    }
    i = resume;
  };

  const run = (from: number, to: number, depth: number): void => {
    const savedEnd = end;
    i = from;
    end = to;
    while (i < end) {
      const t = tokens[i] as Token;
      switch (t.kind) {
        case "bar":
          i += 1;
          break;
        case "gt":
          i += 1;
          st.octave = Math.min(8, st.octave + 1);
          break;
        case "lt":
          i += 1;
          st.octave = Math.max(0, st.octave - 1);
          break;
        case "at":
          i += 1;
          st.inst = t.text;
          events.push({ id: t.text, pulse: st.pulse, type: "inst" });
          break;
        case "fx":
          i += 1;
          handleFx(t);
          break;
        case "lbr":
          handleRepeat(t, depth);
          break;
        case "rbr":
          err(`unexpected "]" at offset ${t.pos}`);
          i += 1;
          break;
        case "word":
          command(t);
          break;
        case "num":
          err(`unexpected number "${t.text}" at offset ${t.pos}`);
          i += 1;
          break;
        default:
          err(`unexpected "${t.text}" at offset ${t.pos}`);
          i += 1;
          break;
      }
    }
    end = savedEnd;
  };

  const command = (t: Token): void => {
    const c = t.text;
    if (SEMITONES[c] !== undefined || c === "n") {
      handleNote(t);
      return;
    }
    i += 1;
    switch (c) {
      case "r": {
        const d = readLength(t.pos);
        events.push({ duration: d, pulse: st.pulse, type: "rest" });
        st.pulse += d;
        break;
      }
      case "o": {
        st.octave = ranged("o", t.pos, readNumber(), 0, 8, st.octave);
        break;
      }
      case "l": {
        st.length = readLength(t.pos);
        break;
      }
      case "v": {
        st.volume = ranged("v", t.pos, readNumber(), 0, 15, st.volume);
        events.push({ pulse: st.pulse, type: "volume", value: st.volume });
        break;
      }
      case "p": {
        st.pan = ranged("p", t.pos, readNumber(), 0, 15, st.pan);
        events.push({ pulse: st.pulse, type: "pan", value: st.pan });
        break;
      }
      case "q": {
        st.gate = ranged("q", t.pos, readNumber(), 1, 8, st.gate);
        break;
      }
      case "k": {
        const n = readSigned();
        if (n === null) {
          err(`"k" needs a signed number of semitones at offset ${t.pos}`);
        } else {
          st.transpose = Math.min(48, Math.max(-48, n));
        }
        break;
      }
      case "t": {
        const n = readNumber();
        const v = ranged("t", t.pos, n, 20, 400, 120);
        if (n !== null) {
          if (tempo === null) {
            tempo = v;
          } else {
            warnAt(
              `only the first "t" sets the tempo, this one was ignored, at offset ${t.pos}`
            );
          }
        }
        break;
      }
      case "w": {
        const n = ranged("w", t.pos, readNumber(), 0, 255, 0);
        if (st.fx.length < 4) {
          st.fx.push(effectFromByte("duty", n));
        }
        break;
      }
      case "L": {
        if (loopPulse === null) {
          loopPulse = st.pulse;
          events.push({ pulse: st.pulse, type: "loop" });
        } else {
          warnAt(
            `only the first "L" is the loop point, this one was ignored, at offset ${t.pos}`
          );
        }
        break;
      }
      default:
        err(`unknown command "${c}" at offset ${t.pos}`);
        break;
    }
  };

  run(0, end, 0);
  if (st.fx.length > 0) {
    warnAt("effects at the end have no note to attach to");
  }
  let endPulse = 0;
  for (const e of events) {
    if (e.type === "note" || e.type === "rest") {
      endPulse = Math.max(endPulse, e.pulse + e.duration);
    }
  }
  return { endPulse, events, issues, loopPulse, tempo };
}
