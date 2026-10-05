/* Pixelkit generator: CRT screen (post).
   A plain ES module. Change anything; the studio and CLI only rely on the contract in @pixelkit/core types. */
import { defineGenerator, param } from "../core/index.ts";

export default defineGenerator("crt", {
  filter: true,
  kind: "post",
  label: "CRT screen",
  parallax: 0,
  params: {
    chroma: param.range("Color split", 0, 3, 1),
    flicker: param.range("Flicker", 0, 0.3, 0.03),
    scanlines: param.range("Scanlines", 0, 1, 0.35, { step: 0.05 }),
  },
  render(c) {
    const { W, H, p, buf, opacity } = c;
    const src = buf.slice(),
      ch = p.chroma,
      fl = 1 - p.flicker * (0.5 + 0.5 * c.wave(40));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4,
          il = (y * W + Math.max(0, x - ch)) * 4,
          ir = (y * W + Math.min(W - 1, x + ch)) * 4,
          s = (y % 2 ? 1 - p.scanlines : 1) * fl;
        // il and ir are fractional when the color split is: the read is then undefined, so NaN keeps the original result
        const r = (src[il] ?? Number.NaN) * s,
          g = (src[i + 1] ?? 0) * s,
          b = (src[ir + 2] ?? Number.NaN) * s;
        buf[i] = (buf[i] ?? 0) + (r - (buf[i] ?? 0)) * opacity;
        buf[i + 1] = (buf[i + 1] ?? 0) + (g - (buf[i + 1] ?? 0)) * opacity;
        buf[i + 2] = (buf[i + 2] ?? 0) + (b - (buf[i + 2] ?? 0)) * opacity;
      }
    }
  },
});
