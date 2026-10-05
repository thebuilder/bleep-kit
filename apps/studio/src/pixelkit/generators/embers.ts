/* Pixelkit generator: Embers and sparks (effect).
   A plain ES module. Change anything; the studio and CLI only rely on the contract in @pixelkit/core types. */
import { defineGenerator, hash2, mod, param } from "../core/index.ts";

const BURST_SECONDS = 2;

export default defineGenerator("embers", {
  blend: "add",
  kind: "effect",
  label: "Embers and sparks",
  parallax: 0,
  params: {
    base: param.range("Base Y", 0, 1, 0.9),
    burst: param.range("Tap burst", 0, 60, 20),
    c1: param.color("Hot", "#ffd060"),
    c2: param.color("Cool", "#ff6a2a"),
    count: param.range("Count", 0, 120, 30),
    drift: param.range("Drift", -2, 2, 0.2, { step: 0.05 }),
    height: param.range("Rise", 0.05, 1, 0.6),
    speed: param.range("Speed", 0.1, 3, 1, { step: 0.05 }),
    spread: param.range("Spread", 0, 1, 0.3),
    x: param.range("Center X", 0, 1, 0.5),
  },
  render(c) {
    const { W, H, p, rng } = c;
    const A = p.c1,
      Bc = p.c2;
    for (let i = 0; i < p.count; i++) {
      const x0 = (p.x + (rng() - 0.5) * p.spread) * W,
        off = rng(),
        sp = 0.6 + rng() * 0.8,
        life = c.phase(p.speed * 0.4 * sp, off, 0.5);
      const y = p.base * H - life * p.height * H,
        x = c.screenX(x0 + Math.sin(life * 9 + i) * 3 + p.drift * life * 30),
        fl = 0.5 + 0.5 * c.wave(12, i * 3),
        a = (1 - life) * (0.5 + 0.5 * fl);
      c.plot(x, y, life < 0.4 ? A : Bc, a);
      if (i % 4 === 0) {
        c.plot(x, y + 1, Bc, a * 0.5);
      }
    }
    // a tap on the embers' column, between their base and how high they rise, throws a burst of sparks from where it
    // landed; the embers stay put on screen, so the tap is compared in screen columns
    const top = (p.base - p.height) * H - 6;
    for (const e of c.taps) {
      const across = Math.abs(mod(e.x - c.left - p.x * W + W / 2, W) - W / 2);
      if (
        !p.burst ||
        e.age >= BURST_SECONDS ||
        across > (p.spread * W) / 2 + 6 ||
        e.y < top ||
        e.y > p.base * H + 6
      ) {
        continue;
      }
      const life = e.age / BURST_SECONDS;
      const k = Math.round(e.x) * 131 + Math.round(e.y); // the same burst every frame, whatever else was tapped
      for (let i = 0; i < p.burst; i++) {
        const vx = (hash2(i, k, 7) - 0.5) * 30;
        const vy = 18 + hash2(i, k, 8) * 30;
        const x = e.x + vx * e.age + p.drift * e.age * 8;
        const y = e.y - vy * e.age + 9 * e.age * e.age;
        c.plot(
          x,
          y,
          life < 0.35 ? A : Bc,
          (1 - life) * (0.6 + 0.4 * hash2(i, k, 9))
        );
      }
    }
  },
});
