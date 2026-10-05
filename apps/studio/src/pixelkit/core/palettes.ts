/* Palette lock applied after all layers. Add your own: name to list of hex colors. */
import { rgb } from "./color.ts";
import type { Color } from "./types.ts";

/** Palettes by name. Add your own here: the name becomes a valid PaletteName in typed presets. */
export const PALETTES = {
  "Dusk 16": [
    "0d0b1a",
    "1c1830",
    "2e2447",
    "4a3462",
    "6b4a7a",
    "9a5f7e",
    "c9787a",
    "f0a07a",
    "ffd3a0",
    "fff1d6",
    "2a4a5e",
    "3f7a82",
    "6fb3a0",
    "a8d8a0",
    "7a2e2a",
    "c9452f",
  ],
  "Ember 8": [
    "140a0a",
    "3a1410",
    "6a2018",
    "a8361c",
    "e0602a",
    "f8a040",
    "ffd878",
    "fff4d0",
  ],
  "Handheld 4": ["0f380f", "306230", "8bac0f", "9bbc0f"],
  "Ice 8": [
    "0b1022",
    "1a2848",
    "2c4a78",
    "4a78a8",
    "7aa8d0",
    "b0d4ec",
    "e4f2fa",
    "ffffff",
  ],
  none: null,
  "PICO-8": [
    "000000",
    "1d2b53",
    "7e2553",
    "008751",
    "ab5236",
    "5f574f",
    "c2c3c7",
    "fff1e8",
    "ff004d",
    "ffa300",
    "ffec27",
    "00e436",
    "29adff",
    "83769c",
    "ff77a8",
    "ffccaa",
  ],
} as const satisfies Record<string, readonly string[] | null>;
export type PaletteName = keyof typeof PALETTES;
/** True for the name of a built-in palette. */
export const isPalette = (name: unknown): name is PaletteName =>
  typeof name === "string" && Object.hasOwn(PALETTES, name);
export const paletteRGB = (name: string): Color[] | null => {
  const v: readonly string[] | null = isPalette(name) ? PALETTES[name] : null;
  return v ? v.map((h) => rgb(`#${h}`)) : null;
};
