/* Pixelkit generator: Light glow (light).
   A plain ES module. Change anything; the studio and CLI only rely on the contract in @pixelkit/core types. */
import { bay, defineGenerator, param } from "../core/index.ts";

export default defineGenerator("glow", {
  blend: "add",
  kind: "light",
  label: "Light glow",
  parallax: 0,
  params: {
    color: param.color("Color", "#ff8a3d"),
    flicker: param.range("Flicker", 0, 1, 0.3, { step: 0.05 }),
    intensity: param.range("Intensity", 0, 1.5, 0.6, { step: 0.05 }),
    radius: param.range("Radius", 3, 160, 40),
    steps: param.range("Steps", 2, 10, 5),
    x: param.range("Position X", 0, 1, 0.5),
    y: param.range("Position Y", 0, 1, 0.8),
  },
  render(c) {
    const { W, H, p } = c;
    const cy = p.y * H,
      r = p.radius,
      Cc = p.color,
      f = 1 - p.flicker * 0.35 * (0.5 + 0.5 * c.wave(9.1) * c.wave(5.3, 1));
    c.repeatX(p.x * W, r, (cx) => {
      for (
        let y = Math.max(0, Math.floor(cy - r));
        y < Math.min(H, Math.ceil(cy + r));
        y++
      ) {
        for (
          let x = Math.max(c.left, Math.floor(cx - r));
          x < Math.min(c.left + W, Math.ceil(cx + r));
          x++
        ) {
          const d = Math.hypot(x - cx, y - cy) / r;
          if (d >= 1) {
            continue;
          }
          const lv = Math.floor((1 - d) * p.steps + bay(x, y)) / p.steps;
          if (lv > 0) {
            c.plot(x, y, Cc, lv * lv * p.intensity * f);
          }
        }
      }
    });
  },
});
