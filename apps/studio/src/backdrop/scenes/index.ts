/* One backdrop scene per chip (section 11.5). Plain Pixelkit scene JSON, normalized once the generators are registered.
   Each scene designs for 320 x 180 and fills the window at a pixel size of 3 to 6. */
import type { ChipId } from "../../lib/contract.ts";

interface L {
  blend?: "normal" | "add";
  name?: string;
  opacity?: number;
  parallax?: number;
  params?: Record<string, unknown>;
  seed?: number;
  type: string;
}

const base = (
  layers: L[],
  opts: { palette?: string; dither?: number } = {}
) => ({
  /* No scene pans: a still camera keeps every scene calm, and only the layers' own motion (twinkle, drift, glow) moves. */
  camera: { speed: 0, x: 0 },
  fps: 12,
  height: 180,
  layers: layers.map((l, i) => ({ name: l.type, seed: 11 + i * 7, ...l })),
  loop: 0,
  name: "Bleepkit backdrop",
  post: { dither: opts.dither ?? 0, palette: opts.palette ?? "none" },
  size: { maxPixel: 6, minPixel: 3, mode: "fill" },
  version: 3,
  width: 320,
});

const pulse = (params: Record<string, unknown>): L => ({
  name: "Pulse",
  params,
  type: "bleep-pulse",
});

const SCENES: Record<ChipId, () => ReturnType<typeof base>> = {
  /* amber dust and glow */
  adlib: () =>
    base([
      {
        params: {
          bands: 8,
          bottom: "#a85a1c",
          meteors: 0,
          mid: "#5a2a10",
          stars: 30,
          style: "sunset",
          top: "#1a0e08",
          twinkle: 0.4,
        },
        type: "sky",
      },
      {
        params: {
          color: "#f3b24a",
          flicker: 0.25,
          intensity: 0.5,
          radius: 130,
          steps: 6,
          x: 0.5,
          y: 0.8,
        },
        type: "glow",
      },
      pulse({
        base: 0.12,
        color: "#ffd27a",
        flash: "#fff0c8",
        ground: 0.95,
        radius: 100,
        x: 0.5,
        y: 0.78,
      }),
      {
        params: {
          alpha: 0.65,
          color: "#ffd98a",
          count: 80,
          drift: 0.35,
          rise: 0.12,
          twinkle: 0.7,
        },
        type: "dust",
      },
      {
        params: { color: "#0a0400", size: 0.5, steps: 4, strength: 0.5 },
        type: "vignette",
      },
    ]),
  /* a blue-purple nebula */
  c64: () =>
    base([
      {
        params: {
          bands: 8,
          bottom: "#4a3ab0",
          meteors: 2,
          mid: "#2a2090",
          stars: 110,
          style: "gradient",
          top: "#14104a",
          twinkle: 0.8,
        },
        type: "sky",
      },
      {
        params: {
          c1: "#6a4ad0",
          c2: "#2a3aa8",
          density: 0.75,
          scale: 1.2,
          stars: 60,
        },
        type: "nebula",
      },
      pulse({
        base: 0.14,
        color: "#b49ae6",
        flash: "#e0d8ff",
        ground: 0.92,
        radius: 110,
        x: 0.5,
        y: 0.5,
      }),
      {
        params: {
          c1: "#ffffff",
          c2: "#b49ae6",
          count: 24,
          h: 0.8,
          rate: 0.6,
          size: 2,
          w: 1,
          x: 0.5,
          y: 0.45,
        },
        type: "sparkles",
      },
      { params: { chroma: 0, flicker: 0.02, scanlines: 0.16 }, type: "crt" },
    ]),
  /* a plain starfield */
  custom: () =>
    base([
      {
        params: {
          bands: 6,
          bottom: "#1d1b30",
          meteors: 4,
          mid: "#12111f",
          stars: 150,
          style: "gradient",
          top: "#07060d",
          twinkle: 0.8,
        },
        type: "sky",
      },
      pulse({
        base: 0.08,
        color: "#9a95ad",
        flash: "#ece7da",
        ground: 0.94,
        radius: 120,
        x: 0.5,
        y: 0.5,
      }),
    ]),
  /* a four shade green sky */
  gameboy: () =>
    base(
      [
        {
          params: {
            bands: 5,
            bottom: "#8bac0f",
            meteors: 2,
            mid: "#306230",
            stars: 50,
            style: "gradient",
            top: "#0b2a0b",
            twinkle: 0.6,
          },
          type: "sky",
        },
        pulse({
          base: 0.18,
          color: "#9bbc0f",
          flash: "#c6e05a",
          ground: 0.9,
          radius: 80,
          x: 0.3,
          y: 0.38,
        }),
        {
          name: "Hills",
          parallax: 0.2,
          params: {
            antennas: false,
            base: 1,
            beacon: "#9bbc0f",
            color: "#0f380f",
            count: 9,
            lit: 0.18,
            maxH: 56,
            minH: 20,
            window: "#9bbc0f",
          },
          type: "skyline",
        },
        {
          params: {
            alpha: 0.6,
            color: "#c6e05a",
            count: 30,
            drift: 0.4,
            rise: 0.15,
            twinkle: 0.6,
          },
          type: "dust",
        },
      ],
      { dither: 0.45, palette: "Handheld 4" }
    ),
  /* a dark sea skyline with embers */
  genesis: () =>
    base([
      {
        params: {
          bands: 9,
          bottom: "#2a6a90",
          meteors: 3,
          mid: "#0e2a52",
          stars: 60,
          style: "gradient",
          top: "#050b1c",
          twinkle: 0.6,
        },
        type: "sky",
      },
      pulse({
        base: 0.14,
        color: "#3ab0d8",
        flash: "#dff4ff",
        ground: 0.8,
        radius: 90,
        x: 0.28,
        y: 0.52,
      }),
      {
        name: "Harbor",
        parallax: 0.2,
        params: {
          antennas: true,
          base: 0.8,
          beacon: "#e2766f",
          color: "#071225",
          count: 12,
          lit: 0.2,
          maxH: 52,
          minH: 14,
          window: "#f3b24a",
        },
        type: "skyline",
      },
      {
        params: {
          deep: "#040d1e",
          glint: "#7fd8f0",
          shallow: "#134a82",
          top: 0.8,
        },
        type: "bleep-sea",
      },
      {
        params: {
          base: 0.8,
          burst: 22,
          c1: "#ffd060",
          c2: "#ff6a2a",
          count: 40,
          drift: 0.3,
          height: 0.6,
          speed: 0.9,
          spread: 1,
          x: 0.5,
        },
        type: "embers",
      },
      {
        params: { color: "#000000", size: 0.6, steps: 4, strength: 0.4 },
        type: "vignette",
      },
    ]),
  /* a still night sky with twinkling stars */
  nes: () =>
    base([
      {
        params: {
          bands: 8,
          bottom: "#4a3478",
          meteors: 0,
          mid: "#201a4e",
          stars: 130,
          style: "gradient",
          top: "#080a22",
          twinkle: 0.9,
        },
        type: "sky",
      },
      pulse({
        base: 0.16,
        color: "#7d97dc",
        flash: "#dfe8ff",
        ground: 0.9,
        radius: 110,
        x: 0.5,
        y: 0.5,
      }),
      {
        params: {
          c1: "#ffffff",
          c2: "#7d97dc",
          count: 22,
          h: 0.8,
          rate: 0.5,
          size: 2,
          w: 1,
          x: 0.5,
          y: 0.45,
        },
        type: "sparkles",
      },
      {
        params: { color: "#000000", size: 0.55, steps: 4, strength: 0.45 },
        type: "vignette",
      },
    ]),
  /* a purple nebula with aurora */
  snes: () =>
    base([
      {
        params: {
          bands: 9,
          bottom: "#4a2a80",
          meteors: 3,
          mid: "#2a1456",
          stars: 100,
          style: "gradient",
          top: "#0c0824",
          twinkle: 0.7,
        },
        type: "sky",
      },
      {
        params: {
          c1: "#8a3ac0",
          c2: "#3a2a8a",
          density: 0.65,
          scale: 1.4,
          stars: 40,
        },
        type: "nebula",
      },
      {
        params: {
          bands: 3,
          c1: "#4dffb0",
          c2: "#a05cff",
          height: 36,
          intensity: 0.75,
          speed: 0.9,
          wave: 0.7,
          y: 0.12,
        },
        type: "aurora",
      },
      pulse({
        base: 0.12,
        color: "#e0b8ff",
        flash: "#f0e0ff",
        ground: 0.92,
        radius: 110,
        x: 0.5,
        y: 0.45,
      }),
      {
        params: { color: "#000000", size: 0.6, steps: 4, strength: 0.4 },
        type: "vignette",
      },
    ]),
};

export function sceneFor(chip: ChipId) {
  return (SCENES[chip] ?? SCENES.nes)();
}
