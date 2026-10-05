/* Pixelkit generator: Aurora (background).
   A plain ES module. Change anything; the studio and CLI only rely on the contract in @pixelkit/core types. */
import {
  bay,
  defineGenerator,
  fbm,
  mix,
  param,
  vnoise,
} from "../core/index.ts";

export default defineGenerator("aurora", {
  blend: "add",
  kind: "background",
  label: "Aurora",
  parallax: 0.03,
  params: {
    bands: param.range("Curtains", 1, 5, 2),
    c1: param.color("Lower edge", "#4dffb0"),
    c2: param.color("Upper glow", "#a05cff"),
    height: param.range("Curtain height", 6, 80, 34),
    intensity: param.range("Intensity", 0, 1.5, 0.7, { step: 0.05 }),
    speed: param.range("Speed", 0, 3, 0.8, { step: 0.05 }),
    wave: param.range("Waviness", 0, 1.5, 0.6, { step: 0.05 }),
    y: param.range("Top", 0, 0.8, 0.1),
  },
  render(c) {
    const { W, H, p, seed } = c;
    const A = p.c1,
      Bc = p.c2;
    for (let b = 0; b < p.bands; b++) {
      const bo = b * 2.3,
        lift = b * p.height * 0.35;
      for (let sx = 0; sx < W; sx++) {
        const X = sx + c.left;
        const edge =
          p.y * H +
          p.height -
          lift +
          c.wave(p.speed, X * 0.03 + bo) * 5 * p.wave +
          (fbm(X * 0.015 + b * 10, seed) - 0.5) * 14 * p.wave;
        const ray =
            0.45 +
            0.55 *
              c.loopBlend((tt) =>
                vnoise(X * 0.45 + b * 7, tt * p.speed * 0.8, seed + b)
              ),
          fade = 0.35 + 0.65 * vnoise(X * 0.04 + b * 3, 1, seed + 9);
        for (let dy = 0; dy < p.height; dy++) {
          const y = Math.round(edge - dy),
            f = dy / p.height;
          const a =
            ((f < 0.06 ? 0.6 + (f / 0.06) * 0.4 : (1 - f) ** 1.5) *
              ray *
              fade *
              p.intensity) /
            (0.6 + p.bands * 0.35);
          if (a < bay(X, y) * 0.28) {
            continue;
          }
          c.plot(X, y, mix(A, Bc, Math.min(1, f * 1.4)), a);
        }
      }
    }
  },
});
