/* Per-chip look: names, spectrum palettes, and which waves an sfx may use. Pure data; the chips' sound rules live in core. */
import type { ChannelKind, ChipId, SfxCategory, SfxWave } from "./contract.ts";

export interface ChipTheme {
  id: ChipId;
  line: string;
  /** low, mid, high colors of the spectrum bars and the master scope */
  ramp: [string, string, string];
  short: string;
}

export const CHIP_THEME: Record<ChipId, ChipTheme> = {
  adlib: {
    id: "adlib",
    line: "#ffd27a",
    ramp: ["#8a4a12", "#f3b24a", "#ffe0a0"],
    short: "AdLib",
  },
  c64: {
    id: "c64",
    line: "#c8b8ff",
    ramp: ["#4a3a9c", "#7869c4", "#b49ae6"],
    short: "C64",
  },
  custom: {
    id: "custom",
    line: "#ece7da",
    ramp: ["#6a6680", "#9a95ad", "#ece7da"],
    short: "Custom",
  },
  gameboy: {
    id: "gameboy",
    line: "#c6e05a",
    ramp: ["#306230", "#8bac0f", "#c6e05a"],
    short: "Game Boy",
  },
  genesis: {
    id: "genesis",
    line: "#7fd8f0",
    ramp: ["#1f56c4", "#3ab0d8", "#ece7da"],
    short: "Mega Drive",
  },
  nes: {
    id: "nes",
    line: "#9db4f0",
    ramp: ["#4a62c4", "#7d97dc", "#f3b24a"],
    short: "NES",
  },
  snes: {
    id: "snes",
    line: "#e0b8ff",
    ramp: ["#5b3a9c", "#a07ad8", "#f0a8e0"],
    short: "SNES",
  },
};

export const chipTheme = (id: ChipId | string | undefined): ChipTheme =>
  CHIP_THEME[id as ChipId] ?? CHIP_THEME.nes;

export const KIND_COLOR: Record<ChannelKind, string> = {
  fm: "var(--k-fm)",
  noise: "var(--k-noise)",
  pulse: "var(--k-pulse)",
  sample: "var(--k-sample)",
  sid: "var(--k-sid)",
  triangle: "var(--k-triangle)",
  wave: "var(--k-wave)",
};
export const KIND_HEX: Record<ChannelKind, string> = {
  fm: "#f3b24a",
  noise: "#9a95ad",
  pulse: "#7d97dc",
  sample: "#e2766f",
  sid: "#b49ae6",
  triangle: "#74c08f",
  wave: "#dc7ba4",
};
export const KIND_LABEL: Record<ChannelKind, string> = {
  fm: "FM",
  noise: "Noise",
  pulse: "Pulse",
  sample: "Sample",
  sid: "SID",
  triangle: "Triangle",
  wave: "Wavetable",
};

/** SFX category colors reuse the kind colors (section 11.6). `ring` adds the red ring of explosion. */
export const CATEGORY_KIND: Record<
  SfxCategory,
  { kind: ChannelKind | "muted"; ring?: string; hint: string }
> = {
  alarm: { hint: "A repeating warning", kind: "fm" },
  blip: { hint: "A tiny menu beep", kind: "pulse" },
  coin: { hint: "A bright pickup chime", kind: "fm" },
  custom: { hint: "Start from a blank slate", kind: "muted" },
  door: { hint: "A creaky slide", kind: "wave" },
  explosion: { hint: "A big rumbling boom", kind: "noise", ring: "#e2766f" },
  hit: { hint: "A short punchy impact", kind: "sample" },
  jump: { hint: "A springy upward bloop", kind: "triangle" },
  laser: { hint: "Pew: a falling zap", kind: "pulse" },
  powerup: { hint: "A rising, shimmering reward", kind: "sid" },
  step: { hint: "A soft footfall", kind: "noise" },
  teleport: { hint: "A swirling warp", kind: "sid" },
  zap: { hint: "A crackle of electricity", kind: "pulse" },
};

export function categoryColor(c: SfxCategory | string): string {
  const spec = CATEGORY_KIND[c as SfxCategory] ?? CATEGORY_KIND.custom;
  return spec.kind === "muted" ? "#9a95ad" : KIND_HEX[spec.kind];
}
export const categoryRing = (c: SfxCategory | string): string | null =>
  CATEGORY_KIND[c as SfxCategory]?.ring ?? null;

/** Which waves each chip allows for an sfx (section 2.4). */
export const CHIP_WAVES: Record<ChipId, SfxWave[]> = {
  adlib: ["fm", "square", "sine", "saw"],
  c64: ["square", "saw", "triangle", "noise"],
  custom: ["square", "triangle", "saw", "sine", "noise", "wave", "fm"],
  gameboy: ["square", "wave", "noise"],
  genesis: ["square", "noise", "fm"],
  nes: ["square", "triangle", "noise"],
  snes: ["sine", "triangle", "saw", "square", "noise"],
};
