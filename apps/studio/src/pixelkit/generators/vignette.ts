/* Pixelkit generator: Vignette (post).
   A plain ES module. Change anything; the studio and CLI only rely on the contract in @pixelkit/core types. */
import { bay, clamp01, defineGenerator, param } from "../core/index.ts";

/** The darkening level of every pixel, which only changes with the view size and the settings: worked out once. */
let last: { key: string; levels: Float32Array } | null = null;
function vignetteLevels(
  W: number,
  H: number,
  size: number,
  strength: number,
  steps: number
): Float32Array {
  const key = `${W},${H},${size},${strength},${steps}`;
  if (last?.key === key) {
    return last.levels;
  }
  const levels = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = (x / W - 0.5) * 2,
        ny = (y / H - 0.5) * 2,
        // biome-ignore lint/suspicious/noApproximativeNumericConstant: the rounded 1.414 is the established falloff divisor; Math.SQRT2 would shift edge pixels and break render parity
        d = Math.hypot(nx, ny) / 1.414,
        e = size * 0.7,
        a = clamp01((d - e) / (1 - e + 0.01)) * strength;
      levels[y * W + x] = Math.floor(a * steps + bay(x, y) * 0.999) / steps;
    }
  }
  last = { key, levels };
  return levels;
}

export default defineGenerator("vignette", {
  filter: true,
  kind: "post",
  label: "Vignette",
  parallax: 0,
  params: {
    color: param.color("Color", "#000000"),
    size: param.range("Clear area", 0, 1, 0.6, { step: 0.05 }),
    steps: param.range("Steps", 2, 8, 4),
    strength: param.range("Strength", 0, 1, 0.5, { step: 0.05 }),
  },
  render(c) {
    const { W, H, p, buf, opacity } = c;
    const Cc = p.color;
    const levels = vignetteLevels(W, H, p.size, p.strength, p.steps);
    for (let j = 0; j < levels.length; j++) {
      const lv = levels[j] as number;
      if (lv <= 0) {
        continue;
      }
      const i = j * 4,
        k = Math.min(1, lv) * opacity;
      buf[i] = (buf[i] ?? 0) + (Cc[0] - (buf[i] ?? 0)) * k;
      buf[i + 1] = (buf[i + 1] ?? 0) + (Cc[1] - (buf[i + 1] ?? 0)) * k;
      buf[i + 2] = (buf[i + 2] ?? 0) + (Cc[2] - (buf[i + 2] ?? 0)) * k;
    }
  },
});
