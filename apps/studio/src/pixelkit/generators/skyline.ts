/* Pixelkit generator: City skyline (background).
   A plain ES module. Change anything; the studio and CLI only rely on the contract in @pixelkit/core types. */
import {
  defineGenerator,
  hash2,
  mix,
  param,
  type RenderContext,
  type RenderValues,
  WHITE,
} from "../core/index.ts";

const params = {
  antennas: param.toggle("Antennas", true),
  base: param.range("Baseline", 0.3, 1, 0.8),
  beacon: param.color("Beacons", "#ff4a5a"),
  color: param.color("Buildings", "#1a1830"),
  count: param.range("Density", 2, 20, 8),
  lit: param.range("Lit windows", 0, 1, 0.35, { step: 0.05 }),
  maxH: param.range("Max height", 6, 100, 55),
  minH: param.range("Min height", 6, 90, 18),
  window: param.color("Windows", "#ffd27a"),
};

function draw(
  c: RenderContext<RenderValues<typeof params>>,
  st: boolean
): void {
  const { W, H, p, seed } = c;
  const Cc = p.color,
    Wn = p.window,
    Bc = p.beacon,
    gy = Math.round(p.base * H),
    edge = mix(Cc, WHITE, 0.08);
  const P = st
      ? c.plot
      : () => {
          // Layout-only pass: advance the PRNG without drawing.
        },
    Rc = st
      ? c.rect
      : () => {
          // Layout-only pass: advance the PRNG without drawing.
        };
  c.tiles(Math.ceil((W / p.count) * 1.3) + 4, (r, bx) => {
    let x = bx;
    while (x < bx + W) {
      const w = Math.max(4, Math.round((W / p.count) * (0.5 + r() * 0.8))),
        h = Math.round(p.minH + r() * Math.max(0, p.maxH - p.minH)),
        top = gy - h,
        roof = r();
      for (let y = top; y < H; y++) {
        for (let k = 0; k < w; k++) {
          P(x + k, y, k === 0 ? edge : Cc, 1);
        }
      }
      if (roof < 0.25) {
        Rc(x + 2, top - 3, Math.max(1, w - 4), 3, Cc);
      } else if (roof < 0.35) {
        for (let k = 0; k < w / 2; k++) {
          Rc(x + k, top - (k * 2 > w / 2 ? 0 : Math.round(k * 0.8)), 1, 1, Cc);
        }
      }
      for (let wy = top + 3; wy < gy - 1; wy += 3) {
        for (let wx = x + 2; wx < x + w - 1; wx += 2) {
          const blink = hash2(wx, wy, seed + 7) < 0.04;
          if (st === blink) {
            continue;
          }
          const on = blink ? c.wave(0.7, wx) > 0 : hash2(wx, wy, seed) < p.lit;
          if (on) {
            c.plot(wx, wy, Wn, 1);
          }
        }
      }
      const ar = r(),
        ahr = r();
      if (p.antennas && ar < 0.4) {
        const ax = x + Math.floor(w / 2),
          ah = 3 + Math.floor(ahr * 6);
        for (let k = 1; k <= ah; k++) {
          P(ax, top - k, Cc, 1);
        }
        if (!st && c.phase(0.5, hash2(ax, 0, seed)) < 0.5) {
          c.glow(ax, top - ah - 1, Bc, 1);
          c.glow(ax + 1, top - ah - 1, Bc, 0.3);
          c.glow(ax - 1, top - ah - 1, Bc, 0.3);
        }
      }
      x += w + (r() < 0.3 ? Math.floor(r() * 3) : 0);
    }
  });
}

export default defineGenerator("skyline", {
  fit: "extend",
  kind: "background",
  label: "City skyline",
  parallax: 0.35,
  params,
  render(c) {
    draw(c, false);
  },
  renderStatic(c) {
    draw(c, true);
  },
});
