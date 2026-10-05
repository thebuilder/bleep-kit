/* Pixelkit generator: Fireflies (effect).
   A plain ES module. Change anything; the studio and CLI only rely on the contract in @pixelkit/core types. */
import { defineGenerator, param, TAU } from "../core/index.ts";

export default defineGenerator("fireflies", {
  blend: "add",
  kind: "effect",
  label: "Fireflies",
  parallax: 0.3,
  params: {
    blink: param.range("Blink rate", 0.1, 3, 1, { step: 0.05 }),
    color: param.color("Color", "#d8ff6a"),
    count: param.range("Count", 0, 80, 20),
    glow: param.range("Glow", 0, 1, 0.5, { step: 0.05 }),
    speed: param.range("Wander speed", 0, 2, 0.5, { step: 0.05 }),
    y0: param.range("Area top", 0, 1, 0.45),
    y1: param.range("Area bottom", 0, 1, 0.9),
  },
  render(c) {
    const { W, H, p, rng } = c;
    const Cc = p.color;
    for (let i = 0; i < c.density(p.count); i++) {
      const x0 = rng() * W,
        yc = p.y0 + rng() * (p.y1 - p.y0),
        ph = rng() * TAU,
        a1 = 0.5 + rng(),
        a2 = 0.5 + rng(),
        bk = 0.7 + rng() * 0.6;
      const x = c.screenX(x0 + c.wave(p.speed * a1, ph) * 10),
        y = yc * H + c.wave(p.speed * a2 * 1.3, ph * 2) * 6;
      let b = Math.max(0, c.wave(p.blink * bk * 2, ph));
      b *= b;
      c.plot(x, y, Cc, b);
      if (b > 0.3 && p.glow > 0) {
        c.plot(x + 1, y, Cc, b * p.glow * 0.5);
        c.plot(x - 1, y, Cc, b * p.glow * 0.5);
        c.plot(x, y + 1, Cc, b * p.glow * 0.5);
        c.plot(x, y - 1, Cc, b * p.glow * 0.5);
        c.plot(x + 1, y + 1, Cc, b * p.glow * 0.2);
        c.plot(x - 1, y - 1, Cc, b * p.glow * 0.2);
        c.plot(x + 1, y - 1, Cc, b * p.glow * 0.2);
        c.plot(x - 1, y + 1, Cc, b * p.glow * 0.2);
      }
    }
  },
});
