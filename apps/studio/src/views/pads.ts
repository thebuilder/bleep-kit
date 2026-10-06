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
import {
  choose,
  debounce,
  fire,
  h,
  reducedMotion,
  reflow,
} from "../lib/dom.ts";
import { playSfx, playSfxValue } from "../playback.ts";
import {
  lengthLabel,
  playLength,
  renderedSeconds,
  renderSfxAsync,
} from "../render-service.ts";
import type { ViewCtx } from "../shell.ts";
import { type Doc, project } from "../state/docs.ts";
import { deleteDocument } from "../ui/delete-doc.ts";
import {
  group,
  inspectorTitle,
  rangeField,
  selectField,
  textField,
} from "../ui/fields.ts";
import { icon } from "../ui/icons.ts";
import { createSfx, pickCategory } from "../ui/pickers.ts";
import { addVisual } from "../visuals/loop.ts";
import {
  createBurstLayer,
  drawThumb,
  THUMB_H,
  THUMB_W,
} from "../visuals/pad-fx.ts";
import { peaks } from "../visuals/waveform.ts";

const KEYS = "1234567890QWERTYUIOP";

/** Pads are ordered by category (coin first), then id, so the first ten keys are the classics. */
function orderedSfx(): Doc[] {
  const rank = (d: Doc) => SFX_CATEGORIES.indexOf((d.value as Sfx).category);
  return project
    .list("sfx")
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

const kbd = (key: string) => `<kbd>${key}</kbd>`;
const keyRange = (keys: string) =>
  keys.length === 1
    ? kbd(keys)
    : `${kbd(keys.slice(0, 1))}-${kbd(keys.slice(-1))}`;

/** The line under the title: which keys play pads, for as many pads as there are (1-0, then Q-P, twenty at most). */
function padKeysHint(count: number): string {
  const n = Math.min(count, KEYS.length);
  if (n === 0) {
    return "Tap New SFX to make your first sound.";
  }
  const ranges = [KEYS.slice(0, n).slice(0, 10), KEYS.slice(10, n)]
    .filter(Boolean)
    .map(keyRange)
    .join(" and ");
  const what = count > n ? `the first ${n}` : choose([[n === 1, "it"]], "them");
  return `Tap a pad to play it. ${n === 1 ? "Key" : "Keys"} ${ranges} play${n === 1 ? "s" : ""} ${what}.`;
}

export function mountPads(ctx: ViewCtx): ViewHooks {
  const { host, insp } = ctx;
  host.innerHTML = `
    <div class="pads-view">
      <div class="pads-head">
        <div><h1 class="vh">Pads</h1><p class="muted" id="padHint"></p></div>
        <div class="pads-legend"><span class="muted mono" id="padCount"></span></div>
      </div>
      <div class="pads-wrap" id="padsWrap"><div class="pads" id="padGrid"></div><canvas class="bursts" id="padBursts"></canvas></div>
    </div>`;
  const grid = host.querySelector("#padGrid") as HTMLElement;
  const wrap = host.querySelector("#padsWrap") as HTMLElement;
  const burstCanvas = host.querySelector("#padBursts") as HTMLCanvasElement;
  const fx = createBurstLayer(wrap, burstCanvas);
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

  /** The tile's length label: what the last render measured, blank until there is one. */
  function setLength(tile: HTMLElement, sfx: Sfx): void {
    (tile.querySelector(".du") as HTMLElement).textContent = lengthLabel(
      renderedSeconds(sfx)
    );
  }

  function colorsOf(s: Sfx) {
    return { color: categoryColor(s.category), ring: categoryRing(s.category) };
  }

  /** Draw a tile's waveform from a render, and write the length that render came out at next to it. */
  function refreshThumb(tile: HTMLElement, sfx: Sfx, color: string): void {
    const canvas = tile.querySelector("canvas") as HTMLCanvasElement;
    const key = canvas.dataset.k ?? "";
    const token = (thumbs.get(key) ?? 0) + 1;
    thumbs.set(key, token);
    renderSfxAsync(sfx, 22_050)
      .then((r) => {
        if (thumbs.get(key) === token) {
          drawThumb(canvas, peaks(r, THUMB_W), color);
          setLength(tile, sfx);
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
    setLength(el, sfx);
    return el;
  }

  function press(doc: Doc, el: HTMLElement): void {
    select(doc.id);
    playSfx(doc);
    el.classList.remove("hit");
    reflow(el);
    el.classList.add("hit");
    fx.light(
      el,
      performance.now() + Math.max(160, playLength(doc.value as Sfx) * 1000)
    );
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
      tile.innerHTML = `<canvas class="thumb" width="${THUMB_W}" height="${THUMB_H}" data-k="${vid}"></canvas><span class="du mono"></span>
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
      setLength(tile, v);
      refreshThumb(tile, v, colorsOf(base).color);
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
      refreshThumb(el, d.value as Sfx, colorsOf(d.value as Sfx).color);
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
    (host.querySelector("#padHint") as HTMLElement).innerHTML = padKeysHint(
      docs.length
    );
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
  /** Without the burst (reduced motion, or the pad is off screen) the pad just lights for a moment. */
  function lightPad(id: string, now: number): void {
    const pe = padEls.get(id);
    if (pe && id) {
      fx.light(pe, now + 200);
    }
  }

  /** A burst around the pad and a sweep across its thumbnail as long as the sound plays; the pad stays lit that long. */
  function launch(id: string, el: HTMLElement, now: number): void {
    const sfx = project.get<Sfx>("sfx", id)?.value;
    const color = sfx ? colorsOf(sfx).color : "#f3b24a";
    fx.burst(el, color, sfx?.category === "explosion", now);
    const thumb = el.querySelector(".thumb");
    if (thumb && sfx) {
      fx.sweep(thumb, color, Math.max(120, playLength(sfx) * 1000), now);
    }
    const pe = padEls.get(id);
    if (pe) {
      pe.classList.remove("hit");
      reflow(pe);
      pe.classList.add("hit");
      fx.light(pe, now + Math.max(160, (sfx ? playLength(sfx) : 0.2) * 1000));
    }
  }

  const off = addVisual((f) => {
    for (const e of f.events) {
      if (e.type !== "trigger") {
        continue;
      }
      const el = targets.get(e.id);
      if (el && !f.reduced) {
        launch(e.id, el, f.time);
      } else {
        lightPad(e.id, f.time);
      }
    }
    fx.draw(f.time);
  });

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
    const title = inspectorTitle(sfx.category, sfx.name);
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
          onclick: () => fire(deleteDocument(doc)),
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
  // the master volume and limiter shape every render, and a slider sends a stream of changes
  const refreshAllThumbs = debounce(() => {
    for (const [pid, el] of padEls) {
      const sfx = project.get<Sfx>("sfx", pid)?.value;
      if (sfx) {
        refreshThumb(el, sfx, colorsOf(sfx).color);
      }
    }
  }, 150);
  const unsub = project.subscribe((e) => {
    if (e.type === "list") {
      rebuild();
    } else if (e.type === "project") {
      refreshAllThumbs();
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
      setLength(el, sfx);
      if (e.cause !== "saved") {
        refreshThumb(el, sfx, color);
      }
    }
  });
  const onResize = () => placeDrawer();
  addEventListener("resize", onResize);
  rebuild();

  ctx.cleanup(() => {
    off();
    unsub();
    refreshAllThumbs.cancel();
    removeEventListener("resize", onResize);
    fx.dispose();
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
