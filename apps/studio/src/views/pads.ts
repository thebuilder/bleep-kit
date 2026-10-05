/* The pads view (home): every sfx as a square pad. Pressing a pad plays it at once and the pad bursts (a square ring,
   pixel particles, a flash of its waveform). Each pad has a dice button for four mutations in a drawer under its row and
   a button that randomizes it; a last pad creates a new sound from a category. Keys 1..9 and 0, then Q..P, play the
   first twenty pads. */
import type { Command, ViewHooks } from "../app.ts";
import { app } from "../app.ts";
import { CHIP_THEME, categoryColor, categoryRing } from "../lib/chips.ts";
import { SFX_CATEGORIES, type Sfx } from "../lib/contract.ts";
import {
  deriveSeed,
  describeSfx,
  mutateMany,
  randomizeSfx,
} from "../lib/core.ts";
import { fire, h, reducedMotion, reflow } from "../lib/dom.ts";
import { playSfx, playSfxValue } from "../playback.ts";
import { peaks, renderSfxAsync } from "../render-service.ts";
import type { ViewCtx } from "../shell.ts";
import { type Doc, project } from "../state/docs.ts";
import { group, rangeField, selectField, textField } from "../ui/fields.ts";
import { icon } from "../ui/icons.ts";
import { createSfx, pickCategory } from "../ui/pickers.ts";
import { hexToRgb, rgba, surface } from "../visuals/canvas.ts";
import { addVisual } from "../visuals/loop.ts";

const KEYS = "1234567890QWERTYUIOP";
const THUMB_W = 48;
const THUMB_H = 22;

/** Pads are ordered by category (coin first), then id, so the first ten keys are the classics. */
export function orderedSfx(): Doc[] {
  const rank = (d: Doc) => SFX_CATEGORIES.indexOf((d.value as Sfx).category);
  return project
    .list("sfx")
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

export const durationOf = (s: Sfx): number =>
  s.envelope.attack + s.envelope.sustain + s.envelope.decay;

function drawThumb(
  canvas: HTMLCanvasElement,
  data: Float32Array | null,
  color: string
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.clearRect(0, 0, THUMB_W, THUMB_H);
  const mid = THUMB_H / 2;
  ctx.fillStyle = rgba(color, 0.22);
  ctx.fillRect(0, Math.floor(mid), THUMB_W, 1);
  if (!data) {
    return;
  }
  for (let x = 0; x < THUMB_W; x += 1) {
    const lo = data[x * 2] ?? 0;
    const hi = data[x * 2 + 1] ?? 0;
    const top = Math.round(mid - Math.min(1, hi * 1.6) * (mid - 1));
    const bot = Math.round(mid - Math.max(-1, lo * 1.6) * (mid - 1));
    ctx.fillStyle = color;
    ctx.fillRect(x, top, 1, Math.max(1, bot - top));
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(x, top, 1, 1);
  }
}

interface Burst {
  at: number;
  big: boolean;
  color: string;
  rect: { x: number; y: number; w: number; h: number };
  seed: number;
}
const BURST_MS = 380;

/** The playhead that sweeps across a pad's waveform thumbnail while its sound plays. */
interface Sweep {
  at: number;
  color: string;
  ms: number;
  rect: { x: number; y: number; w: number; h: number };
}

export function mountPads(ctx: ViewCtx): ViewHooks {
  const { host, insp } = ctx;
  host.innerHTML = `
    <div class="pads-view">
      <div class="pads-head">
        <div><h1 class="vh">Pads</h1><p class="muted">Tap a pad to play it. Keys <kbd>1</kbd>-<kbd>0</kbd> and <kbd>Q</kbd>-<kbd>P</kbd> play the first twenty.</p></div>
        <div class="pads-legend"><span class="muted mono" id="padCount"></span></div>
      </div>
      <div class="pads-wrap" id="padsWrap"><div class="pads" id="padGrid"></div><canvas class="bursts" id="padBursts"></canvas></div>
    </div>`;
  const grid = host.querySelector("#padGrid") as HTMLElement;
  const wrap = host.querySelector("#padsWrap") as HTMLElement;
  const burstCanvas = host.querySelector("#padBursts") as HTMLCanvasElement;
  const burstSurface = surface(burstCanvas);
  const padEls = new Map<string, HTMLElement>();
  const targets = new Map<string, HTMLElement>();
  const thumbs = new Map<string, number>();
  let selected: string | null = null;
  let lastEdited: Doc | null = null;
  let drawer: {
    id: string;
    seed: number;
    variants: Sfx[];
    el: HTMLElement;
  } | null = null;
  const bursts: Burst[] = [];
  const sweeps: Sweep[] = [];
  const litUntil = new Map<string, number>();

  function colorsOf(s: Sfx) {
    return { color: categoryColor(s.category), ring: categoryRing(s.category) };
  }

  function refreshThumb(
    doc: Doc,
    canvas: HTMLCanvasElement,
    color: string
  ): void {
    const sfx = doc.value as Sfx;
    const token = (thumbs.get(canvas.dataset.k ?? doc.id) ?? 0) + 1;
    thumbs.set(canvas.dataset.k ?? doc.id, token);
    renderSfxAsync(sfx, 22_050)
      .then((r) => {
        if (thumbs.get(canvas.dataset.k ?? doc.id) === token) {
          drawThumb(canvas, peaks(r, THUMB_W), color);
        }
      })
      .catch(() => drawThumb(canvas, null, color));
  }

  function buildPad(doc: Doc, index: number): HTMLElement {
    const sfx = doc.value as Sfx;
    const { color, ring } = colorsOf(sfx);
    const key = KEYS[index] ?? "";
    const el = h("div", {
      "aria-label": `Play ${sfx.name}`,
      class: "pad",
      "data-id": doc.id,
      role: "button",
      style: `--kc:${color};${ring ? `--ring:${ring};` : ""}`,
      tabindex: "0",
    });
    el.innerHTML = `
      <span class="key">${key}</span>
      <span class="ci">${icon(sfx.category, 16)}</span>
      <canvas class="thumb" width="${THUMB_W}" height="${THUMB_H}" data-k="${doc.id}"></canvas>
      <span class="nm"></span>
      <span class="du mono"></span>
      <span class="pad-btns">
        <button class="mini" data-act="mutate" title="Mutate: four variations" aria-label="Mutate ${sfx.name}">${icon("dice", 12)}</button>
        <button class="mini" data-act="randomize" title="Randomize this pad" aria-label="Randomize ${sfx.name}">${icon("refresh", 12)}</button>
      </span>`;
    (el.querySelector(".nm") as HTMLElement).textContent = sfx.name;
    (el.querySelector(".du") as HTMLElement).textContent =
      `${durationOf(sfx).toFixed(2)}s`;
    return el;
  }

  function press(doc: Doc, el: HTMLElement): void {
    select(doc.id);
    playSfx(doc);
    el.classList.remove("hit");
    reflow(el);
    el.classList.add("hit");
    litUntil.set(
      doc.id,
      performance.now() + Math.max(160, durationOf(doc.value as Sfx) * 1000)
    );
    el.classList.add("lit");
  }

  function randomize(doc: Doc): void {
    const old = doc.value as Sfx;
    const seed = deriveSeed(old.seed, Math.floor(performance.now()));
    project.edit<Sfx>(doc, (d) => {
      const fresh = randomizeSfx(d, seed % 1_000_000);
      return { ...fresh, category: d.category, chip: d.chip, name: d.name };
    });
    lastEdited = doc;
    playSfx(doc);
    app.toast(`Randomized ${old.name}`, "Undo", () => {
      project.undo(doc);
      playSfx(doc);
    });
  }

  function placeDrawer(): void {
    if (!drawer) {
      return;
    }
    const ordered = [
      ...grid.querySelectorAll<HTMLElement>(".pad:not(.pad-new)"),
    ];
    const i = ordered.findIndex((p) => p.dataset.id === drawer?.id);
    if (i < 0) {
      drawer.el.remove();
      return;
    }
    const cols = Math.max(
      1,
      getComputedStyle(grid).gridTemplateColumns.split(" ").length
    );
    const lastInRow = Math.min(
      ordered.length - 1,
      (Math.floor(i / cols) + 1) * cols - 1
    );
    ordered[lastInRow]?.after(drawer.el);
    drawer.el.style.setProperty(
      "--anchor",
      `${(((i % cols) + 0.5) / cols) * 100}%`
    );
  }

  function closeDrawer(): void {
    drawer?.el.remove();
    for (const k of [...targets.keys()]) {
      if (k.startsWith("variant:")) {
        targets.delete(k);
      }
    }
    for (const p of padEls.values()) {
      p.classList.remove("open");
    }
    drawer = null;
  }

  function openDrawer(doc: Doc, reroll = false): void {
    const sameDoc = drawer?.id === doc.id;
    if (sameDoc && !reroll) {
      closeDrawer();
      return;
    }
    const seed =
      reroll && drawer
        ? drawer.seed + 1
        : (project.project.seed * 31 + (doc.value as Sfx).seed) % 100_000;
    closeDrawer();
    const base = doc.value as Sfx;
    const variants = mutateMany(base, { amount: 0.2, count: 4, seed });
    const el = h("div", {
      class: "drawer",
      style: `--kc:${colorsOf(base).color}`,
    });
    el.innerHTML = `<div class="drawer-h"><span class="pxh">Mutations of ${base.name.replace(/[<>&]/g, "")}</span><span class="grow"></span>
      <button class="btn small" data-act="reroll">${icon("shuffle", 12)}More</button><button class="btn small ghost icon" data-act="close" aria-label="Close drawer">${icon("close", 12)}</button></div><div class="drawer-g"></div>`;
    const g = el.querySelector(".drawer-g") as HTMLElement;
    for (const [i, v] of variants.entries()) {
      const vid = `variant:${doc.id}:${i}`;
      const tile = h("div", {
        "aria-label": `Play variation ${i + 1}`,
        class: "vtile",
        role: "button",
        tabindex: "0",
      });
      tile.innerHTML = `<canvas class="thumb" width="${THUMB_W}" height="${THUMB_H}" data-k="${vid}"></canvas><span class="du mono">${durationOf(v).toFixed(2)}s</span>
        <span class="vbtns"><button class="btn small primary" data-act="play">${icon("play", 10)}</button><button class="btn small" data-act="keep">${icon("save", 12)}Keep</button></span>`;
      const doPlay = () => {
        playSfxValue(vid, v);
        tile.classList.remove("hit");
        reflow(tile);
        tile.classList.add("hit");
      };
      tile.addEventListener("pointerdown", (e) => {
        if ((e.target as HTMLElement).closest("[data-act=keep]")) {
          return;
        }
        e.preventDefault();
        doPlay();
      });
      tile.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          doPlay();
        }
      });
      (tile.querySelector("[data-act=keep]") as HTMLElement).addEventListener(
        "click",
        async (e) => {
          e.stopPropagation();
          const id = project.uniqueId("sfx", `${doc.id}-mod`);
          const kept = await project.create("sfx", id, {
            ...v,
            name: `${base.name} mod`,
          });
          app.toast(`Kept as ${kept.id}`, "Open", () =>
            app.navigate(`#/sfx/${kept.id}`)
          );
        }
      );
      targets.set(vid, tile);
      g.append(tile);
      renderSfxAsync(v, 22_050)
        .then((r) =>
          drawThumb(
            tile.querySelector("canvas") as HTMLCanvasElement,
            peaks(r, THUMB_W),
            colorsOf(base).color
          )
        )
        .catch(() => undefined);
    }
    el.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")
        ?.dataset.act;
      if (act === "close") {
        closeDrawer();
      } else if (act === "reroll") {
        openDrawer(doc, true);
      }
    });
    drawer = { el, id: doc.id, seed, variants };
    padEls.get(doc.id)?.classList.add("open");
    placeDrawer();
    el.scrollIntoView({
      behavior: reducedMotion() ? "auto" : "smooth",
      block: "nearest",
    });
  }

  function select(id: string): void {
    if (selected === id) {
      return;
    }
    selected = id;
    for (const [pid, el] of padEls) {
      el.classList.toggle("sel", pid === id);
    }
    renderInspector();
  }

  function rebuild(): void {
    closeDrawer();
    padEls.clear();
    for (const k of [...targets.keys()]) {
      targets.delete(k);
    }
    const docs = orderedSfx();
    grid.replaceChildren();
    for (const [i, d] of docs.entries()) {
      const el = buildPad(d, i);
      padEls.set(d.id, el);
      targets.set(d.id, el);
      grid.append(el);
      refreshThumb(
        d,
        el.querySelector("canvas") as HTMLCanvasElement,
        colorsOf(d.value as Sfx).color
      );
    }
    const add = h("button", {
      "aria-label": "New sound effect",
      class: "pad pad-new",
    });
    add.innerHTML = `<span class="plus">${icon("plus", 32)}</span><span class="nm">New SFX</span><span class="du">pick a flavor</span>`;
    add.addEventListener("click", () =>
      pickCategory((c) => fire(createSfx(c)))
    );
    grid.append(add);
    (host.querySelector("#padCount") as HTMLElement).textContent =
      `${docs.length} sound${docs.length === 1 ? "" : "s"}`;
    if (!(selected && padEls.has(selected))) {
      selected = null;
      const [first] = docs;
      if (first) {
        select(first.id);
      } else {
        renderInspector();
      }
    }
    for (const [pid, el] of padEls) {
      el.classList.toggle("sel", pid === selected);
    }
  }

  /* ----- input ----- */
  grid.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    const pad = t.closest<HTMLElement>(".pad:not(.pad-new)");
    if (!pad || t.closest(".mini")) {
      return;
    }
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    const doc = project.get("sfx", pad.dataset.id ?? "");
    if (doc) {
      pad.focus({ preventScroll: true });
      press(doc, pad);
    }
  });
  grid.addEventListener("keydown", (e) => {
    const pad = (e.target as HTMLElement).closest<HTMLElement>(
      ".pad:not(.pad-new)"
    );
    if (pad && (e.key === "Enter" || e.key === " ") && e.target === pad) {
      e.preventDefault();
      e.stopPropagation();
      const doc = project.get("sfx", pad.dataset.id ?? "");
      if (doc) {
        press(doc, pad);
      }
    }
  });
  grid.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".mini");
    if (!btn) {
      return;
    }
    const pad = btn.closest<HTMLElement>(".pad");
    const doc = project.get("sfx", pad?.dataset.id ?? "");
    if (!doc) {
      return;
    }
    e.stopPropagation();
    select(doc.id);
    if (btn.dataset.act === "mutate") {
      openDrawer(doc);
    } else {
      randomize(doc);
    }
  });
  grid.addEventListener("dblclick", (e) => {
    const pad = (e.target as HTMLElement).closest<HTMLElement>(
      ".pad:not(.pad-new)"
    );
    if (pad && !(e.target as HTMLElement).closest(".mini")) {
      app.navigate(`#/sfx/${pad.dataset.id}`);
    }
  });

  /* ----- visuals: bursts and pad lighting ----- */
  const off = addVisual((f) => {
    for (const e of f.events) {
      if (e.type !== "trigger") {
        continue;
      }
      const el = targets.get(e.id);
      if (!el || f.reduced) {
        const pe = padEls.get(e.id);
        if (pe && e.id) {
          litUntil.set(e.id, f.time + 200);
          pe.classList.add("lit");
        }
        continue;
      }
      const wr = wrap.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const sfx = project.get<Sfx>("sfx", e.id)?.value;
      const color = sfx ? colorsOf(sfx).color : "#f3b24a";
      bursts.push({
        at: f.time,
        big: sfx?.category === "explosion",
        color,
        rect: {
          h: r.height,
          w: r.width,
          x: r.left - wr.left,
          y: r.top - wr.top,
        },
        seed: Math.floor(f.time) % 97,
      });
      const thumb = el.querySelector(".thumb");
      if (thumb && sfx) {
        const tr = thumb.getBoundingClientRect();
        sweeps.push({
          at: f.time,
          color,
          ms: Math.max(120, durationOf(sfx) * 1000),
          rect: {
            h: tr.height,
            w: tr.width,
            x: tr.left - wr.left,
            y: tr.top - wr.top,
          },
        });
      }
      const pe = padEls.get(e.id);
      if (pe) {
        pe.classList.remove("hit");
        reflow(pe);
        pe.classList.add("hit", "lit");
        litUntil.set(
          e.id,
          f.time + Math.max(160, (sfx ? durationOf(sfx) : 0.2) * 1000)
        );
      }
    }
    for (const [id, until] of litUntil) {
      if (f.time > until) {
        padEls.get(id)?.classList.remove("lit");
        litUntil.delete(id);
      }
    }
    drawBursts(f.time);
  });

  function drawBursts(now: number): void {
    const { ctx: c } = burstSurface;
    if (wrap.scrollHeight !== burstCanvas.clientHeight) {
      burstCanvas.style.height = `${wrap.scrollHeight}px`;
      burstSurface.fit();
    }
    c.clearRect(0, 0, burstSurface.w, burstSurface.h);
    for (let i = sweeps.length - 1; i >= 0; i -= 1) {
      const sw = sweeps[i] as Sweep;
      const p = (now - sw.at) / sw.ms;
      if (p > 1) {
        sweeps.splice(i, 1);
        continue;
      }
      // the part already played brightens, a hard 2 px playhead leads it
      const x = Math.round(sw.rect.x + p * sw.rect.w);
      c.fillStyle = "rgba(255,255,255,0.16)";
      c.fillRect(sw.rect.x, sw.rect.y, x - sw.rect.x, sw.rect.h);
      c.fillStyle = rgba(sw.color, 0.35);
      c.fillRect(x - 4, sw.rect.y, 4, sw.rect.h);
      c.fillStyle = "#fff";
      c.fillRect(x - 1, sw.rect.y - 2, 2, sw.rect.h + 4);
    }
    for (let i = bursts.length - 1; i >= 0; i -= 1) {
      const b = bursts[i] as Burst;
      const age = now - b.at;
      if (age > BURST_MS) {
        bursts.splice(i, 1);
        continue;
      }
      const t = age / BURST_MS;
      const cx = b.rect.x + b.rect.w / 2;
      const cy = b.rect.y + b.rect.h / 2;
      // a flash of the whole pad, then rings leaving it
      if (t < 0.4) {
        c.fillStyle = rgba(b.color, (1 - t / 0.4) ** 2 * 0.35);
        c.fillRect(b.rect.x, b.rect.y, b.rect.w, b.rect.h);
      }
      const ring = (grow: number, alpha: number, thick: number) => {
        const half = (b.rect.w / 2) * (0.55 + t * grow);
        const step = 4;
        const sx = Math.round((cx - half) / step) * step;
        const sy = Math.round((cy - half) / step) * step;
        const size = Math.round((half * 2) / step) * step;
        c.fillStyle = rgba(b.color, alpha);
        c.fillRect(sx, sy, size, thick);
        c.fillRect(sx, sy + size - thick, size, thick);
        c.fillRect(sx, sy, thick, size);
        c.fillRect(sx + size - thick, sy, thick, size);
      };
      ring(1.1, (1 - t) * 1, t < 0.5 ? 6 : 3);
      if (t > 0.12) {
        ring(0.85, (1 - t) * 0.5, 3);
      }
      // pixel particles
      const n = b.big ? 18 : 12;
      const [r, g, bl] = hexToRgb(b.color);
      for (let k = 0; k < n; k += 1) {
        const ang = ((k + (b.seed % 5) * 0.13) / n) * Math.PI * 2;
        const dist = (b.rect.w * 0.3 + (k % 3) * 10) * (0.5 + t * 1.7);
        const px = Math.round((cx + Math.cos(ang) * dist) / 3) * 3;
        const py = Math.round((cy + Math.sin(ang) * dist + t * t * 22) / 3) * 3;
        c.fillStyle = `rgba(${r},${g},${bl},${Math.min(1, (1 - t) * 1.3)})`;
        const sz = k % 2 ? 4 : 8;
        c.fillRect(px, py, sz, sz);
      }
    }
  }

  /* ----- inspector ----- */
  function renderInspector(): void {
    insp.replaceChildren();
    const doc = selected ? project.get<Sfx>("sfx", selected) : undefined;
    const inner = h("div", { class: "insp-in" });
    insp.append(inner);
    if (!doc) {
      inner.append(
        h(
          "div",
          { class: "hint" },
          "Pick a pad to see its details here. Use the New SFX pad to make your first sound."
        )
      );
      return;
    }
    const sfx = doc.value;
    const title = h("div", { class: "insp-title" });
    title.innerHTML = `${icon(sfx.category, 16)}<span class="nm"></span>`;
    (title.querySelector(".nm") as HTMLElement).textContent = sfx.name;
    (title.querySelector(".ico") as SVGElement).style.color = categoryColor(
      sfx.category
    );
    const open = h(
      "button",
      { class: "btn small", onclick: () => app.navigate(`#/sfx/${doc.id}`) },
      "Open editor"
    );
    title.append(open);
    inner.append(title);
    inner.append(h("div", { class: "hint desc" }, describeSfx(sfx)));
    const g = group("This pad", { key: "pad-insp" });
    textField(g.body, {
      label: "Name",
      onInput: (v) => {
        lastEdited = doc;
        project.edit<Sfx>(
          doc,
          (d) => {
            d.name = v;
          },
          "pad-name"
        );
        const el = padEls.get(doc.id);
        const nm = el?.querySelector(".nm");
        if (nm) {
          nm.textContent = v;
        }
      },
      value: sfx.name,
    });
    rangeField(g.body, {
      label: "Volume",
      max: 1,
      min: 0,
      onInput: (v) => {
        lastEdited = doc;
        project.edit<Sfx>(
          doc,
          (d) => {
            d.volume = v;
          },
          "pad-vol"
        );
      },
      step: 0.01,
      value: sfx.volume,
    });
    selectField(g.body, {
      label: "Category",
      onInput: (v) => {
        lastEdited = doc;
        project.edit<Sfx>(doc, (d) => {
          d.category = v;
        });
        const el = padEls.get(doc.id);
        el?.style.setProperty("--kc", categoryColor(v));
        const ci = el?.querySelector(".ci");
        if (ci) {
          ci.innerHTML = icon(v, 16);
        }
      },
      options: SFX_CATEGORIES,
      value: sfx.category,
    });
    inner.append(g.el);
    const actions = h("div", { class: "hint btn-row" });
    actions.append(
      h(
        "button",
        { class: "btn small", onclick: () => openDrawer(doc) },
        "Mutate"
      ),
      h(
        "button",
        { class: "btn small", onclick: () => randomize(doc) },
        "Randomize"
      ),
      h(
        "button",
        {
          class: "btn small",
          onclick: () =>
            fire(
              project
                .duplicate(doc)
                .then((d) => app.toast(`Duplicated as ${d.id}`))
            ),
        },
        "Duplicate"
      ),
      h(
        "button",
        {
          class: "btn small",
          onclick: () => app.navigate(`#/analysis/sfx/${doc.id}`),
        },
        "Analyse"
      ),
      h(
        "button",
        {
          class: "btn small danger",
          onclick: () => {
            fire(
              project.remove(doc).then(() => app.toast(`Deleted ${doc.id}`))
            );
          },
        },
        "Delete"
      )
    );
    inner.append(actions);
    inner.append(
      h(
        "div",
        { class: "hint" },
        `Chip: ${CHIP_THEME[sfx.chip].short}. Double-click a pad, or Open editor, to shape the sound.`
      )
    );
  }

  /* ----- project changes ----- */
  const unsub = project.subscribe((e) => {
    if (e.type === "list") {
      rebuild();
    } else if (e.type === "doc") {
      const doc = project.docs.get(e.path);
      if (doc?.kind !== "sfx") {
        return;
      }
      const el = padEls.get(doc.id);
      if (!el) {
        return;
      }
      const sfx = doc.value as Sfx;
      const { color, ring } = colorsOf(sfx);
      el.style.setProperty("--kc", color);
      if (ring) {
        el.style.setProperty("--ring", ring);
      } else {
        el.style.removeProperty("--ring");
      }
      (el.querySelector(".nm") as HTMLElement).textContent = sfx.name;
      (el.querySelector(".du") as HTMLElement).textContent =
        `${durationOf(sfx).toFixed(2)}s`;
      if (e.cause !== "saved") {
        refreshThumb(
          doc,
          el.querySelector("canvas") as HTMLCanvasElement,
          color
        );
      }
    }
  });
  const onResize = () => placeDrawer();
  addEventListener("resize", onResize);
  rebuild();

  ctx.cleanup(() => {
    off();
    unsub();
    removeEventListener("resize", onResize);
    burstSurface.dispose();
    bursts.length = 0;
    sweeps.length = 0;
  });
  ctx.setChip(project.project.chip);

  const commands = (): Command[] => [
    {
      group: "Pads",
      icon: "dice",
      id: "pads:mutate",
      run: () => selected && openDrawer(project.get("sfx", selected) as Doc),
      title: "Mutate the selected pad",
    },
    {
      group: "Pads",
      icon: "refresh",
      id: "pads:randomize",
      run: () => selected && randomize(project.get("sfx", selected) as Doc),
      title: "Randomize the selected pad",
    },
  ];

  return {
    chip: () => project.project.chip,
    commands,
    doc: () => lastEdited,
    onKey(e) {
      const i = KEYS.indexOf(e.key.toUpperCase());
      if (i < 0 || e.key.length !== 1) {
        return false;
      }
      const doc = orderedSfx()[i];
      const el = doc ? padEls.get(doc.id) : undefined;
      if (doc && el) {
        press(doc, el);
        return true;
      }
      return false;
    },
    play() {
      const doc = selected ? project.get("sfx", selected) : undefined;
      if (doc) {
        const el = padEls.get(doc.id);
        if (el) {
          press(doc, el);
        }
      }
    },
  };
}
