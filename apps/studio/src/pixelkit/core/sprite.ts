/* Sprites: hand-drawn pixel art as rows of characters, one character per pixel and a palette that maps characters to
   colors. '.' and spaces are always empty; '-' and '=' are never pixels either. One character means one UTF-16 code
   unit, so emoji cannot be pixels. A sprite has one or more frames, and optionally tap frames that play once when the
   sprite is tapped. The text form, used by the studio and handy in code: palette lines (a character, '=', a color),
   then rows, with a line '---' between frames and a line '--- tap' before the tap frames.

     k = #1a1420
     s = #e8b48a
     ..kk..
     .kssk.
     ---
     ..kk..
     .kssk.
     --- tap
     ..kk..
*/
import type { Color } from "./types.ts";

export interface SpriteValue {
  /** Frames, each a list of rows. */
  frames: string[][];
  /** Character to '#rrggbb'. */
  palette: Record<string, string>;
  /** Frames played once when the sprite is tapped. */
  tap?: string[][];
}

export const SPRITE_LIMITS = {
  colors: 32,
  frames: 16,
  size: 64,
} as const;
const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Characters that are never pixels: '.' and spaces are empty, '-' starts a frame separator, '=' a palette line. */
const RESERVED = /[.\s=-]/;
const SURROGATE = /[\uD800-\uDFFF]/g;
const HALF_EMOJI = /[\uD800-\uDFFF]/;
/** A palette key: one character that can be a pixel. */
const isKey = (ch: string): boolean =>
  ch.length === 1 && !RESERVED.test(ch) && !HALF_EMOJI.test(ch);
/** Any line with '=' is a palette line, since '=' is never a pixel. */
const PALETTE_LINE = /^(.*?)\s*=\s*(.*)$/;
/** A palette line written with ':' instead of '='. */
const COLON_LINE = /^\S\s*:\s*#/;
const SEPARATOR = /^---\s*(tap)?\s*$/i;
const LINE_BREAK = /\r?\n/;

const hex6 = (v: string): string => {
  const h = v.slice(1).toLowerCase();
  return `#${h.length === 3 ? [...h].map((c) => c + c).join("") : h}`;
};

/** Frames from JSON, cut to the limits; null when there are none. */
function cleanFrames(v: unknown): string[][] | null {
  if (!Array.isArray(v)) {
    return null;
  }
  const frames = v
    .slice(0, SPRITE_LIMITS.frames)
    .filter((f): f is unknown[] => Array.isArray(f))
    .map((f) =>
      f
        .slice(0, SPRITE_LIMITS.size)
        .map((row) =>
          typeof row === "string"
            ? row.replace(SURROGATE, ".").slice(0, SPRITE_LIMITS.size)
            : ""
        )
    )
    .filter((f) => f.length > 0);
  return frames.length ? frames : null;
}

/** A sprite from JSON, checked and cut to the limits, or null when it is not one. */
export function cleanSprite(v: unknown): SpriteValue | null {
  if (!v || typeof v !== "object") {
    return null;
  }
  const s = v as Record<string, unknown>;
  const frames = cleanFrames(s.frames);
  if (!frames) {
    return null;
  }
  const palette: Record<string, string> = {};
  const given =
    s.palette && typeof s.palette === "object"
      ? Object.entries(s.palette as Record<string, unknown>)
      : [];
  const valid = given.filter(
    (e): e is [string, string] =>
      isKey(e[0]) && typeof e[1] === "string" && COLOR.test(e[1])
  );
  for (const [ch, col] of valid.slice(0, SPRITE_LIMITS.colors)) {
    palette[ch] = hex6(col);
  }
  const tap = cleanFrames(s.tap);
  return tap ? { frames, palette, tap } : { frames, palette };
}

/** Parse the text form. Throws with the line number when a line is neither a palette entry, a separator nor a row. */
export function parseSprite(text: string): SpriteValue {
  const palette: Record<string, string> = {};
  const frames: string[][] = [[]];
  const tap: string[][] = [];
  let target = frames;
  for (const [i, raw] of text.split(LINE_BREAK).entries()) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const pal = PALETTE_LINE.exec(trimmed);
    const sep = SEPARATOR.exec(trimmed);
    if (COLON_LINE.test(trimmed)) {
      throw new Error(
        `Line ${i + 1}: write palette lines with '=', like k = #1a1420.`
      );
    }
    if (pal) {
      const [, key = "", col = ""] = pal;
      if (!isKey(key)) {
        throw new Error(
          `Line ${i + 1}: "${key}" cannot be a pixel. Use one character other than '.', '-', '=', a space or an emoji.`
        );
      }
      if (!COLOR.test(col)) {
        throw new Error(
          `Line ${i + 1}: "${col}" is not a #rgb or #rrggbb color.`
        );
      }
      palette[key] = hex6(col);
    } else if (sep) {
      if (sep[1]) {
        target = tap;
      }
      target.push([]);
    } else {
      (target.at(-1) as string[]).push(line);
    }
  }
  const clean = cleanSprite({
    frames: frames.filter((f) => f.length),
    palette,
    tap: tap.filter((f) => f.length),
  });
  if (!clean) {
    throw new Error("A sprite needs at least one row of pixels.");
  }
  return clean;
}

/**
 * A frame as text lines. Every character without a color is written as '.', so rows keep their width (trailing empty
 * pixels included), an empty row is still a row, and no row can be read back as a palette line or a separator.
 */
function frameText(f: readonly string[], palette: Record<string, string>) {
  return f
    .map((row) =>
      row
        ? [...row].map((ch) => (Object.hasOwn(palette, ch) ? ch : ".")).join("")
        : "."
    )
    .join("\n");
}
/** The text form of a sprite (parseSprite reads it back). */
export function formatSprite(s: SpriteValue): string {
  const pal = Object.entries(s.palette).map(([ch, col]) => `${ch} = ${col}`);
  const text = (f: readonly string[]) => frameText(f, s.palette);
  const frames = s.frames.map(text).join("\n---\n");
  const tap = s.tap?.length
    ? `\n--- tap\n${s.tap.map(text).join("\n---\n")}`
    : "";
  return `${pal.join("\n")}\n${frames}${tap}\n`;
}

/** Freeze a sprite and everything in it, so a shared default can never be changed in place. */
export function freezeSprite<S extends SpriteValue>(s: S): S {
  Object.freeze(s.palette);
  for (const f of [...s.frames, ...(s.tap ?? [])]) {
    Object.freeze(f);
  }
  Object.freeze(s.frames);
  if (s.tap) {
    Object.freeze(s.tap);
  }
  return Object.freeze(s);
}

/** Things in a sprite that are allowed but probably mistakes: characters used in rows that have no color. */
export function spriteWarnings(s: SpriteValue): string[] {
  const missing = new Set<string>();
  for (const f of [...s.frames, ...(s.tap ?? [])]) {
    for (const row of f) {
      for (const ch of row) {
        if (!(RESERVED.test(ch) || Object.hasOwn(s.palette, ch))) {
          missing.add(ch);
        }
      }
    }
  }
  return [...missing].map(
    (ch) => `"${ch}" has no color, so it is drawn empty.`
  );
}

/** Width and height of the largest frame. */
export function spriteSize(s: SpriteValue): { w: number; h: number } {
  let w = 0;
  let h = 0;
  for (const f of [...s.frames, ...(s.tap ?? [])]) {
    h = Math.max(h, f.length);
    for (const row of f) {
      w = Math.max(w, row.length);
    }
  }
  return { h, w };
}

/** The palette as colors, for drawing. Characters with no color are left out (drawn as empty). */
export function spriteColors(s: SpriteValue): Map<string, Color> {
  const out = new Map<string, Color>();
  for (const [ch, col] of Object.entries(s.palette)) {
    const n = Number.parseInt(col.slice(1), 16);
    out.set(ch, Object.freeze([(n >> 16) & 255, (n >> 8) & 255, n & 255]));
  }
  return out;
}
