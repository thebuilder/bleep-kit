/* The audio reactive layer of the backdrop (section 11.5): a `bleep-pulse` generator, a live light layer whose
   intensity follows the master level and the events the engine reports: a breathing glow, a ring on every fourth row,
   sparkle bursts for coin, powerup and blip sounds, and lightning strikes for explosion and hit. The studio feeds it
   through `reactive`; the generator draws from that state, so it is `live` and drawn every frame. A second small
   generator, `bleep-sea`, draws the dark water of the Mega Drive scene. */

import { choose } from "../lib/dom.ts";
import {
  bay,
  defineGenerator,
  hash2,
  mulberry32,
  param,
  TAU,
} from "../pixelkit/core/index.ts";

interface Burst {
  at: number;
  color: [number, number, number];
  x: number;
  y: number;
}
interface Strike {
  at: number;
  big: boolean;
  seed: number;
  x: number;
}

export const reactive = {
  bursts: [] as Burst[],
  level: 0,
  /** 0..1 pulse from bass notes, decays */
  pulse: 0,
  rings: [] as number[],
  strikes: [] as Strike[],
  /** scene clock in seconds, set before every render */
  t: 0,
};

export function resetReactive(): void {
  reactive.level = 0;
  reactive.pulse = 0;
  reactive.rings.length = 0;
  reactive.bursts.length = 0;
  reactive.strikes.length = 0;
}

const BURST_S = 0.8;
const STRIKE_S = 0.34;
const RING_S = 0.7;

export const bleepPulse = defineGenerator("bleep-pulse", {
  blend: "add",
  kind: "light",
  label: "Bleep pulse",
  live: true,
  parallax: 0,
  params: {
    base: param.range("Resting light", 0, 1, 0.12, { step: 0.01 }),
    color: param.color("Color", "#7d97dc"),
    flash: param.color("Strike color", "#dfe8ff"),
    gain: param.range("Reactivity", 0, 4, 1.6, { step: 0.05 }),
    ground: param.range("Ground line", 0, 1, 1, { step: 0.01 }),
    radius: param.range("Radius", 8, 220, 80),
    x: param.range("Position X", 0, 1, 0.5),
    y: param.range("Position Y", 0, 1, 0.55),
  },
  render(c) {
    const { W, H, p } = c;
    const { t } = reactive;
    const level = Math.min(1, reactive.level * 3);
    const k = p.base + level * 0.55 * p.gain + reactive.pulse * 0.4 * p.gain;
    const cy = p.y * H;
    const r = p.radius * (0.82 + level * 0.5 + reactive.pulse * 0.25);
    const cx = c.screenX(p.x * W);
    const steps = 6;
    if (k > 0.01) {
      for (
        let y = Math.max(0, Math.floor(cy - r));
        y < Math.min(H, Math.ceil(cy + r));
        y += 1
      ) {
        for (let x = Math.floor(cx - r); x < Math.ceil(cx + r); x += 1) {
          const d = Math.hypot(x - cx, (y - cy) * 1.15) / r;
          if (d >= 1) {
            continue;
          }
          const lv = Math.floor((1 - d) * steps + bay(x, y)) / steps;
          if (lv > 0) {
            c.glow(x, y, p.color, lv * lv * Math.min(1.2, k));
          }
        }
      }
    }
    // rings on every fourth row, rising from the ground line (the bottom edge unless a scene has a ground to stand on)
    const gy = p.ground * H;
    for (const at of reactive.rings) {
      const age = t - at;
      if (age < 0 || age > RING_S) {
        continue;
      }
      const f = age / RING_S;
      const rr = 6 + f * Math.min(W * 0.45, 90);
      const a = (1 - f) * 0.5;
      const n = Math.max(24, Math.round(rr * 3));
      for (let i = 0; i < n; i += 1) {
        const ang = (i / n) * Math.PI;
        c.glow(
          cx + Math.cos(ang) * rr * 1.5,
          gy - Math.sin(ang) * rr * 0.55,
          p.color,
          a
        );
      }
    }
    // sparkle bursts
    for (const b of reactive.bursts) {
      const age = t - b.at;
      if (age < 0 || age > BURST_S) {
        continue;
      }
      const f = age / BURST_S;
      const bx = c.screenX(b.x * W);
      const by = b.y * H;
      for (let i = 0; i < 12; i += 1) {
        const ang = hash2(i, Math.floor(b.x * 997), 3) * TAU;
        const sp = 10 + hash2(i, Math.floor(b.x * 991), 4) * 26;
        const x = bx + Math.cos(ang) * sp * age * 1.4;
        const y = by + Math.sin(ang) * sp * age - 18 * age * age * -1;
        c.glow(x, y, b.color, (1 - f) * 0.9);
        if (i % 3 === 0 && f < 0.6) {
          c.glow(x + 1, y, b.color, (1 - f) * 0.35);
          c.glow(x - 1, y, b.color, (1 - f) * 0.35);
          c.glow(x, y - 1, b.color, (1 - f) * 0.35);
        }
      }
    }
    // lightning
    for (const s of reactive.strikes) {
      const age = t - s.at;
      if (age < 0 || age > STRIKE_S) {
        continue;
      }
      const f = age / STRIKE_S;
      const flicker = choose(
        [
          [f < 0.5, 1],
          [f < 0.65, 0.2],
        ],
        0.7
      );
      const a = (1 - f) * flicker;
      const rng = mulberry32(s.seed);
      let x = c.screenX(s.x * W);
      let y = 0;
      const gyy = gy - 4;
      const branch: [number, number][] = [];
      while (y < gyy) {
        const ny = Math.min(gyy, y + 6 + rng() * 10);
        const nx = x + (rng() - 0.5) * 16;
        c.line(x, y, nx, ny, p.flash, a, 1);
        if (rng() < 0.3) {
          branch.push([nx, ny]);
        }
        x = nx;
        y = ny;
      }
      for (const [bx, by] of branch) {
        c.line(
          bx,
          by,
          bx + (rng() - 0.5) * 30,
          Math.min(gyy, by + 14 + rng() * 14),
          p.flash,
          a * 0.55,
          1
        );
      }
      c.rect(0, 0, W, H, p.flash, a * (s.big ? 0.16 : 0.07));
    }
  },
});

export const bleepSea = defineGenerator("bleep-sea", {
  fit: "extend",
  kind: "background",
  label: "Bleep sea",
  live: true,
  parallax: 0.1,
  params: {
    deep: param.color("Deep", "#07142a"),
    glint: param.color("Glint", "#7fd8f0"),
    shallow: param.color("Surface", "#14407a"),
    top: param.range("Horizon", 0.4, 0.95, 0.8, { step: 0.01 }),
  },
  render(c) {
    const { W, H, p } = c;
    const y0 = Math.floor(p.top * H);
    for (let y = y0; y < H; y += 1) {
      const f = (y - y0) / Math.max(1, H - y0);
      const row = Math.floor(f * 6 + bay(y, 0)) / 6;
      const col: [number, number, number] = [
        p.shallow[0] + (p.deep[0] - p.shallow[0]) * row,
        p.shallow[1] + (p.deep[1] - p.shallow[1]) * row,
        p.shallow[2] + (p.deep[2] - p.shallow[2]) * row,
      ];
      c.rect(c.left, y, W, 1, col, 1);
      // shimmering glints, more of them near the horizon
      const wob = c.wave(0.8, y * 0.6);
      const count = Math.round(5 * (1 - f) + 1);
      for (let i = 0; i < count; i += 1) {
        const gx =
          c.left +
          ((((hash2(i, y, c.seed) * W + wob * 6 + c.t * (4 + (y % 3))) % W) +
            W) %
            W);
        const len = 2 + Math.floor(hash2(i, y, c.seed + 1) * 5 * (1 - f * 0.5));
        const tw = c.wave(2 + (y % 5) * 0.3, i * 3 + y);
        if (tw > 0.2) {
          c.rect(
            gx,
            y,
            len,
            1,
            p.glint,
            0.25 * tw * (1 - f * 0.6) + reactive.level * 0.4
          );
        }
      }
    }
  },
});
