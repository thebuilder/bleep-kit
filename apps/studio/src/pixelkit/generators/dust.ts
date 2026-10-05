/* Pixelkit generator: Dust motes (effect).
   A plain ES module. Change anything; the studio and CLI only rely on the contract in @pixelkit/core types. */
import { defineGenerator, mod, param } from "../core/index.ts";

export default defineGenerator("dust", {
  blend: "add",
  kind: "effect",
  label: "Dust motes",
  parallax: 0.2,
  params: {
    alpha: param.range("Brightness", 0, 1, 0.5, { step: 0.05 }),
    color: param.color("Color", "#fff2d0"),
    count: param.range("Count", 0, 200, 40),
    drift: param.range("Drift", -2, 2, 0.3, { step: 0.05 }),
    rise: param.range("Rise", -2, 2, 0.1, { step: 0.05 }),
    twinkle: param.range("Twinkle", 0, 1, 0.5, { step: 0.05 }),
  },
  render(c) {
    const { W, H, p, rng } = c;
    const Cc = p.color;
    for (let i = 0; i < c.density(p.count); i++) {
      const x0 = rng() * W,
        y0 = rng() * H,
        s1 = 0.5 + rng(),
        s2 = 0.5 + rng();
      const [fx, y, fa] = c.move(
          [x0, y0],
          [p.drift * 8 * s1, -p.rise * 8 * s2],
          [W, H],
          x0 / W
        ),
        x = mod(fx + c.wave(0.8, i) * 2, W);
      c.plot(
        c.screenX(x),
        y,
        Cc,
        fa * p.alpha * (1 - p.twinkle * 0.5 * (1 + c.wave(2, i * 1.3)))
      );
    }
  },
});
