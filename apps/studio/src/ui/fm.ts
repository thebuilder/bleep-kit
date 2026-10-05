/* FM helpers: the eight four-operator algorithm diagrams (YM2612 numbering) and the two two-operator ones, drawn as
   small pixel-art SVGs, plus a mini envelope graph for an operator. */
import type { FmOperator } from "../lib/contract.ts";

interface Node {
  x: number;
  y: number;
}
interface Algo {
  edges: [number, number][];
  nodes: Node[];
  out: number[];
}

const A4: Algo[] = [
  {
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
    nodes: [
      { x: 1, y: 8 },
      { x: 11, y: 8 },
      { x: 21, y: 8 },
      { x: 31, y: 8 },
    ],
    out: [3],
  },
  {
    edges: [
      [0, 2],
      [1, 2],
      [2, 3],
    ],
    nodes: [
      { x: 1, y: 2 },
      { x: 1, y: 14 },
      { x: 14, y: 8 },
      { x: 27, y: 8 },
    ],
    out: [3],
  },
  {
    edges: [
      [0, 3],
      [1, 2],
      [2, 3],
    ],
    nodes: [
      { x: 1, y: 2 },
      { x: 1, y: 14 },
      { x: 14, y: 14 },
      { x: 27, y: 8 },
    ],
    out: [3],
  },
  {
    edges: [
      [0, 1],
      [1, 3],
      [2, 3],
    ],
    nodes: [
      { x: 1, y: 2 },
      { x: 14, y: 2 },
      { x: 1, y: 14 },
      { x: 27, y: 8 },
    ],
    out: [3],
  },
  {
    edges: [
      [0, 1],
      [2, 3],
    ],
    nodes: [
      { x: 1, y: 2 },
      { x: 14, y: 2 },
      { x: 1, y: 14 },
      { x: 14, y: 14 },
    ],
    out: [1, 3],
  },
  {
    edges: [
      [0, 1],
      [0, 2],
      [0, 3],
    ],
    nodes: [
      { x: 1, y: 8 },
      { x: 16, y: 0 },
      { x: 16, y: 8 },
      { x: 16, y: 16 },
    ],
    out: [1, 2, 3],
  },
  {
    edges: [[0, 1]],
    nodes: [
      { x: 1, y: 2 },
      { x: 14, y: 2 },
      { x: 1, y: 14 },
      { x: 14, y: 14 },
    ],
    out: [1, 2, 3],
  },
  {
    edges: [],
    nodes: [
      { x: 1, y: 2 },
      { x: 14, y: 2 },
      { x: 1, y: 14 },
      { x: 14, y: 14 },
    ],
    out: [0, 1, 2, 3],
  },
];
const A2: Algo[] = [
  {
    edges: [[0, 1]],
    nodes: [
      { x: 4, y: 8 },
      { x: 22, y: 8 },
    ],
    out: [1],
  },
  {
    edges: [],
    nodes: [
      { x: 6, y: 2 },
      { x: 6, y: 14 },
    ],
    out: [0, 1],
  },
];

const BOX = 8;

/** SVG markup for an algorithm diagram; `ops` is 2 or 4. */
export function algorithmSvg(algorithm: number, ops: 2 | 4): string {
  const a = (ops === 2 ? A2 : A4)[
    Math.min(algorithm, (ops === 2 ? A2 : A4).length - 1)
  ] as Algo;
  const parts: string[] = [];
  for (const [from, to] of a.edges) {
    const f = a.nodes[from] as Node;
    const t = a.nodes[to] as Node;
    const x1 = f.x + BOX;
    const y1 = f.y + BOX / 2;
    const x2 = t.x;
    const y2 = t.y + BOX / 2;
    const mx = Math.round((x1 + x2) / 2);
    // pixel elbow: right, vertical, right
    parts.push(
      `<path d="M${x1} ${y1}H${mx}V${y2}H${x2}" fill="none" stroke="currentColor" stroke-width="1" opacity=".75"/>`
    );
    parts.push(
      `<rect x="${x2 - 1}" y="${y2 - 1}" width="1" height="2" fill="currentColor"/>`
    );
  }
  a.nodes.slice(0, ops).forEach((n, i) => {
    const isOut = a.out.includes(i);
    parts.push(
      `<rect x="${n.x}" y="${n.y}" width="${BOX}" height="${BOX}" fill="${isOut ? "var(--accent)" : "var(--raised)"}" stroke="currentColor" stroke-width="1"/>`
    );
    parts.push(
      `<text x="${n.x + BOX / 2}" y="${n.y + BOX - 1.8}" text-anchor="middle" font-size="6.5" fill="${isOut ? "var(--accent-ink)" : "currentColor"}" font-family="Silkscreen, monospace">${i + 1}</text>`
    );
    if (isOut) {
      parts.push(
        `<path d="M${n.x + BOX} ${n.y + BOX / 2}h3" stroke="var(--accent)" stroke-width="1"/>`
      );
    }
  });
  return `<svg viewBox="-1 -1 40 26" width="100%" height="100%" shape-rendering="crispEdges" role="img" aria-label="Algorithm ${algorithm}">${parts.join("")}</svg>`;
}

/** A tiny envelope picture: attack up, decay to the sustain level, a slow second decay, then the release. */
export function drawOpEnvelope(
  canvas: HTMLCanvasElement,
  op: FmOperator,
  color: string
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  const w = canvas.width;
  const hh = canvas.height;
  ctx.clearRect(0, 0, w, hh);
  ctx.fillStyle = "#0e0d14";
  ctx.fillRect(0, 0, w, hh);
  // rate (0..31) to a width: faster is shorter
  const seg = (rate: number, max: number) => 1 + (1 - rate / max) * 14;
  const a = seg(op.attack, 31);
  const d = seg(op.decay, 31);
  const s = 4 + (1 - op.sustainRate / 31) * 14;
  const r = seg(op.release * 2, 31);
  const total = a + d + s + r + 6;
  const k = (w - 2) / total;
  const { level } = op;
  const top = 3;
  const base = hh - 3;
  const yAt = (v: number) => Math.round(base - v * (base - top));
  const sus =
    level * (1 - op.sustainLevel * 0.9) * 0 + level * (1 - op.sustainLevel);
  const pts: [number, number][] = [];
  let x = 1;
  pts.push([x, yAt(0)]);
  x += a * k;
  pts.push([x, yAt(level)]);
  x += d * k;
  pts.push([x, yAt(Math.max(0.02, sus))]);
  x += (s + 6) * k;
  pts.push([x, yAt(Math.max(0, sus * (op.sustainRate >= 31 ? 0.05 : 0.55)))]);
  x += r * k;
  pts.push([Math.min(w - 1, x), yAt(0)]);
  ctx.fillStyle = `${color}33`;
  ctx.beginPath();
  ctx.moveTo(pts[0]?.[0] ?? 0, base);
  for (const [px, py] of pts) {
    ctx.lineTo(px, py);
  }
  ctx.lineTo(pts.at(-1)?.[0] ?? w, base);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  pts.forEach(([px, py], i) => {
    if (i === 0) {
      ctx.moveTo(px, py + 0.5);
    } else {
      ctx.lineTo(px, py + 0.5);
    }
  });
  ctx.stroke();
}

/** Pixel-art picture of a pulse width: a square wave whose high part is `duty` of the period. */
export function dutySvg(duty: number): string {
  const W = 24;
  const hi = Math.max(1, Math.min(W - 1, Math.round(W * duty)));
  const d = `M0 12V12H0V4H${hi}V12H${W}`;
  return `<svg viewBox="-1 0 26 16" width="100%" height="100%" shape-rendering="crispEdges" aria-hidden="true"><path d="M0 12H1V4H${hi}V12H${W}" fill="none" stroke="currentColor" stroke-width="2"/><path d="${d}" fill="none" stroke="none"/></svg>`;
}
