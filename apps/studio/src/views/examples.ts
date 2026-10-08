/* The examples view (`#/examples`): the demo project that ships with the studio (examples/demo, bundled at build time)
   as songs and sound effects you can play right here and copy into your own project. Playing goes through the real
   engine with the documents' own values, so the project is not touched; "Add to project" copies a song together with
   the instruments it uses (see examples/copy.ts). */
import type { ViewHooks } from "../app.ts";
import { app } from "../app.ts";
import { engine } from "../engine/engine.ts";
import {
  type ExampleSfx,
  type ExampleSong,
  exampleCatalog,
} from "../examples/catalog.ts";
import { addToProject, type CopyPick } from "../examples/copy.ts";
import { categoryColor, categoryRing, chipTheme } from "../lib/chips.ts";
import type { ChipId } from "../lib/contract.ts";
import { fire, h, reflow } from "../lib/dom.ts";
import { playSfxValue, playSongValue, stopEverything } from "../playback.ts";
import {
  lengthLabel,
  playLength,
  renderedSeconds,
  renderSfxAsync,
} from "../render-service.ts";
import type { ViewCtx } from "../shell.ts";
import { project } from "../state/docs.ts";
import { group, inspectorTitle } from "../ui/fields.ts";
import { icon } from "../ui/icons.ts";
import { addVisual } from "../visuals/loop.ts";
import {
  createBurstLayer,
  drawThumb,
  THUMB_H,
  THUMB_W,
} from "../visuals/pad-fx.ts";
import { peaks } from "../visuals/waveform.ts";

/** What the engine calls an example, so it can never be taken for a document of the project. */
const exampleKey = (id: string): string => `example:${id}`;

const SECONDS_PER_MINUTE = 60;
const clock = (seconds: number): string => {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / SECONDS_PER_MINUTE)}:${String(whole % SECONDS_PER_MINUTE).padStart(2, "0")}`;
};
const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

type Pick = { kind: "song"; id: string } | { kind: "sfx"; id: string };

export function mountExamples(ctx: ViewCtx): ViewHooks {
  const { host, insp } = ctx;
  const catalog = exampleCatalog();
  const { songs, sets, sfx } = catalog;
  host.innerHTML = `
    <div class="pads-view ex-view">
      <div class="pads-head">
        <div>
          <h1 class="vh">Examples</h1>
          <p class="muted">The demo project that comes with Bleepkit. Play anything here without touching your project, and add what you like: a song brings the instruments it uses.</p>
        </div>
        <div class="ex-head-r">
          <span class="muted mono" id="exCount"></span>
          <button class="btn primary" id="exAll" title="Copy every song, sound effect and instrument into the project"></button>
        </div>
      </div>
      <div class="pads-wrap" id="exWrap">
        <section class="ex-sec" aria-labelledby="exSongsH">
          <h2 class="ex-h" id="exSongsH"><span class="pxh">Songs</span><span class="muted mono">one per chip</span></h2>
          <div class="ex-songs" id="exSongs"></div>
        </section>
        <div id="exSets"></div>
        <canvas class="bursts" id="exBursts"></canvas>
      </div>
    </div>`;
  const q = <T extends HTMLElement>(sel: string) =>
    host.querySelector(sel) as T;
  const wrap = q("#exWrap");
  const fx = createBurstLayer(wrap, q<HTMLCanvasElement>("#exBursts"));
  const cards = new Map<string, HTMLElement>();
  const tiles = new Map<string, HTMLElement>();
  const thumbTokens = new Map<string, number>();
  let selected: Pick | null = songs[0]
    ? { id: songs[0].id, kind: "song" }
    : null;
  let busy = false;
  // the chip the badge and backdrop follow: the last example played, else the project's
  let { chip } = project.project;
  const follow = (next: ChipId) => {
    chip = next;
    ctx.setChip(next);
  };

  /* ----- playing ----- */
  const songPlaying = (id: string): boolean =>
    engine.playing && engine.hasSong(exampleKey(id));

  function playSong(ex: ExampleSong): void {
    if (songPlaying(ex.id)) {
      stopEverything();
      return;
    }
    const instruments = Object.fromEntries(
      ex.instrumentIds.flatMap((id) => {
        const inst = catalog.instruments[id];
        return inst ? [[id, inst] as const] : [];
      })
    );
    playSongValue(exampleKey(ex.id), ex.song, instruments);
    follow(ex.chip);
  }

  function playSfx(ex: ExampleSfx, el?: HTMLElement): void {
    playSfxValue(exampleKey(ex.id), ex.sfx);
    follow(ex.chip);
    const tile = el ?? tiles.get(ex.id);
    if (tile) {
      tile.classList.remove("hit");
      reflow(tile);
      tile.classList.add("hit");
    }
  }

  function syncPlaying(): void {
    for (const ex of songs) {
      const card = cards.get(ex.id);
      const on = songPlaying(ex.id);
      card?.classList.toggle("lit", on);
      const btn = card?.querySelector<HTMLElement>("[data-act=play]");
      if (btn) {
        btn.innerHTML = `${icon(on ? "stop" : "play", 12)}${on ? "Stop" : "Play"}`;
        btn.setAttribute("aria-label", `${on ? "Stop" : "Play"} ${ex.name}`);
      }
    }
    if (selected?.kind === "song") {
      renderInspector();
    }
  }

  /* ----- adding ----- */
  async function add(
    pick: CopyPick,
    done: (made: Awaited<ReturnType<typeof addToProject>>) => void
  ): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    try {
      done(await addToProject(catalog, pick));
    } catch (err) {
      app.toast(`Could not add: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  }

  function addSong(ex: ExampleSong): void {
    fire(
      add({ songs: [ex] }, ({ docs, plan }) => {
        const song = docs.find((d) => d.kind === "song");
        const n = plan.instruments.size;
        app.toast(`Added ${song?.id ?? ex.id} with ${plural(n, "instrument")}`);
        if (song) {
          app.navigate(`#/song/${encodeURIComponent(song.id)}`);
        }
      })
    );
  }

  function addSfx(ex: ExampleSfx): void {
    fire(
      add({ sfx: [ex] }, ({ docs }) => {
        const [doc] = docs;
        if (doc) {
          app.toast(`Added ${doc.id}`, "Open", () =>
            app.navigate(`#/sfx/${encodeURIComponent(doc.id)}`)
          );
        }
      })
    );
  }

  function addAll(): void {
    fire(
      add(
        { instruments: Object.keys(catalog.instruments), sfx, songs },
        ({ docs }) => {
          const n = (kind: string) =>
            docs.filter((d) => d.kind === kind).length;
          app.toast(
            `Added ${plural(n("song"), "song")}, ${plural(n("sfx"), "sound effect")} and ${plural(n("instrument"), "instrument")}`,
            "Open pads",
            () => app.navigate("#/pads")
          );
        }
      )
    );
  }

  /* ----- the page ----- */
  function songCard(ex: ExampleSong): HTMLElement {
    const theme = chipTheme(ex.chip);
    const el = h("article", {
      class: "xcard",
      "data-id": ex.id,
      style: `--kc:${theme.ramp[1]}`,
    });
    el.innerHTML = `
      <header class="xcard-h">
        <span class="ci">${icon(ex.chip, 16)}</span>
        <h3 class="nm"></h3>
        <span class="chip-badge">${icon(ex.chip, 12)}<span>${theme.short}</span></span>
      </header>
      <p class="xdetail muted"></p>
      <dl class="xmeta mono">
        <div><dt>Tempo</dt><dd>${ex.tempo} bpm</dd></div>
        <div><dt>Length</dt><dd>${clock(ex.seconds)}</dd></div>
        <div><dt>Style</dt><dd class="style"></dd></div>
      </dl>
      <div class="xfoot">
        <button class="btn small" data-act="play"></button>
        <button class="btn small" data-act="add" title="Copy this song and its ${plural(ex.instrumentIds.length, "instrument")} into the project">${icon("plus", 12)}Add to project</button>
      </div>`;
    (el.querySelector(".nm") as HTMLElement).textContent = ex.name;
    (el.querySelector(".xdetail") as HTMLElement).textContent =
      ex.detail || " ";
    (el.querySelector(".style") as HTMLElement).textContent = ex.style;
    return el;
  }

  function refreshThumb(
    tile: HTMLElement,
    ex: ExampleSfx,
    color: string
  ): void {
    const canvas = tile.querySelector("canvas") as HTMLCanvasElement;
    const token = (thumbTokens.get(ex.id) ?? 0) + 1;
    thumbTokens.set(ex.id, token);
    renderSfxAsync(ex.sfx, 22_050)
      .then((r) => {
        if (thumbTokens.get(ex.id) === token) {
          drawThumb(canvas, peaks(r, THUMB_W), color);
          (tile.querySelector(".du") as HTMLElement).textContent = lengthLabel(
            renderedSeconds(ex.sfx)
          );
        }
      })
      .catch(() => drawThumb(canvas, null, color));
  }

  function sfxTile(ex: ExampleSfx): HTMLElement {
    const color = categoryColor(ex.category);
    const ring = categoryRing(ex.category);
    const el = h("div", {
      "aria-label": `Play ${ex.name}`,
      class: "pad xpad",
      "data-id": ex.id,
      role: "button",
      style: `--kc:${color};${ring ? `--ring:${ring};` : ""}`,
      tabindex: "0",
      title: ex.detail ? `${ex.name} (${ex.detail})` : ex.name,
    });
    el.innerHTML = `
      <span class="ci">${icon(ex.category, 16)}</span>
      <canvas class="thumb" width="${THUMB_W}" height="${THUMB_H}"></canvas>
      <span class="nm"></span>
      <span class="du mono"></span>
      <span class="xbtns">
        <button class="btn small primary icon" data-act="play" aria-label="Play ${ex.name.replace(/"/g, "")}" title="Play">${icon("play", 12)}</button>
        <button class="btn small" data-act="add" title="Copy this sound effect into the project">${icon("plus", 12)}Add</button>
      </span>`;
    (el.querySelector(".nm") as HTMLElement).textContent = ex.name;
    refreshThumb(el, ex, color);
    return el;
  }

  function build(): void {
    const songBox = q("#exSongs");
    for (const ex of songs) {
      const card = songCard(ex);
      cards.set(ex.id, card);
      songBox.append(card);
    }
    const setBox = q("#exSets");
    for (const set of sets) {
      const grid = h("div", { class: "pads ex-pads" });
      for (const ex of set.sfx) {
        const tile = sfxTile(ex);
        tiles.set(ex.id, tile);
        grid.append(tile);
      }
      const head = h("h2", { class: "ex-h" });
      head.innerHTML = `<span class="ex-set-t">${icon(set.chip, 16)}<span class="pxh"></span></span><span class="muted"></span>`;
      (head.querySelector(".pxh") as HTMLElement).textContent =
        `${set.title} sound effects`;
      (head.querySelector(".muted") as HTMLElement).textContent =
        `${set.style}, ${set.sfx.length}`;
      setBox.append(h("section", { class: "ex-sec" }, head, grid));
    }
    q("#exCount").textContent =
      `${plural(songs.length, "song")}, ${plural(sfx.length, "sound")}`;
    q("#exAll").innerHTML = `${icon("plus", 14)}Add all`;
    syncPlaying();
    markSelected();
  }

  /* ----- input ----- */
  const songOf = (el: Element | null): ExampleSong | undefined =>
    songs.find(
      (s) => s.id === el?.closest<HTMLElement>("[data-id]")?.dataset.id
    );
  const sfxOf = (el: Element | null): ExampleSfx | undefined =>
    sfx.find((s) => s.id === el?.closest<HTMLElement>("[data-id]")?.dataset.id);

  const selectedSong = (): ExampleSong | undefined =>
    selected?.kind === "song"
      ? songs.find((s) => s.id === selected?.id)
      : undefined;
  const selectedSfx = (): ExampleSfx | undefined =>
    selected?.kind === "sfx"
      ? sfx.find((s) => s.id === selected?.id)
      : undefined;

  function markSelected(): void {
    for (const [id, el] of cards) {
      el.classList.toggle(
        "sel",
        selected?.kind === "song" && selected.id === id
      );
    }
    for (const [id, el] of tiles) {
      el.classList.toggle(
        "sel",
        selected?.kind === "sfx" && selected.id === id
      );
    }
  }

  function select(next: Pick): void {
    selected = next;
    markSelected();
    renderInspector();
  }

  q("#exSongs").addEventListener("click", (e) => {
    const ex = songOf(e.target as Element);
    if (!ex) {
      return;
    }
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")
      ?.dataset.act;
    select({ id: ex.id, kind: "song" });
    if (act === "play") {
      playSong(ex);
    } else if (act === "add") {
      addSong(ex);
    }
  });
  const sfxGrids = q("#exSets");
  sfxGrids.addEventListener("pointerdown", (e) => {
    const target = e.target as HTMLElement;
    const ex = sfxOf(target);
    if (!ex || e.button !== 0 || target.closest("button")) {
      return;
    }
    e.preventDefault();
    const tile = target.closest<HTMLElement>(".xpad");
    tile?.focus({ preventScroll: true });
    select({ id: ex.id, kind: "sfx" });
    playSfx(ex, tile ?? undefined);
  });
  sfxGrids.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(
      "button[data-act]"
    );
    const ex = sfxOf(btn);
    if (!(btn && ex)) {
      return;
    }
    select({ id: ex.id, kind: "sfx" });
    if (btn.dataset.act === "play") {
      playSfx(ex);
    } else {
      addSfx(ex);
    }
  });
  sfxGrids.addEventListener("keydown", (e) => {
    const tile = (e.target as HTMLElement).closest<HTMLElement>(".xpad");
    const ex = sfxOf(tile);
    if (
      tile &&
      ex &&
      e.target === tile &&
      (e.key === "Enter" || e.key === " ")
    ) {
      e.preventDefault();
      e.stopPropagation();
      select({ id: ex.id, kind: "sfx" });
      playSfx(ex, tile);
    }
  });
  q("#exAll").addEventListener("click", addAll);

  /* ----- visuals: the same burst and playhead sweep as the pads ----- */
  function launch(ex: ExampleSfx, el: HTMLElement, now: number): void {
    const color = categoryColor(ex.category);
    fx.burst(el, color, ex.category === "explosion", now);
    const thumb = el.querySelector(".thumb");
    if (thumb) {
      fx.sweep(thumb, color, Math.max(120, playLength(ex.sfx) * 1000), now);
    }
    fx.light(el, now + Math.max(160, playLength(ex.sfx) * 1000));
  }
  const off = addVisual((f) => {
    for (const e of f.events) {
      const ex =
        e.type === "trigger" && e.id.startsWith("example:")
          ? sfx.find((s) => exampleKey(s.id) === e.id)
          : undefined;
      const el = ex ? tiles.get(ex.id) : undefined;
      if (ex && el && !f.reduced) {
        launch(ex, el, f.time);
      } else if (ex && el) {
        fx.light(el, f.time + 200);
      }
    }
    fx.draw(f.time);
  });

  /* ----- inspector ----- */
  function renderInspector(): void {
    insp.replaceChildren();
    const inner = h("div", { class: "insp-in" });
    insp.append(inner);
    const song = selectedSong();
    const one = selectedSfx();
    if (song) {
      inner.append(...songInspector(song));
    } else if (one) {
      inner.append(...sfxInspector(one));
    } else {
      inner.append(
        h("div", { class: "hint" }, "Pick an example to see its details here.")
      );
    }
  }

  function songInspector(ex: ExampleSong): HTMLElement[] {
    const title = inspectorTitle(ex.chip, ex.name);
    const on = songPlaying(ex.id);
    const g = group("This song", { key: "ex-song" });
    const rows: [string, string][] = [
      ["Chip", chipTheme(ex.chip).short],
      ["Style", ex.style],
      ["Tempo", `${ex.tempo} bpm`],
      ["Length", clock(ex.seconds)],
      ["Channels", String(ex.song.channels.length)],
      ["Instruments", String(ex.instrumentIds.length)],
    ];
    for (const [label, value] of rows) {
      g.body.append(
        h(
          "div",
          { class: "fld" },
          h("span", { class: "lab" }, label),
          h("span", { class: "val wide" }, value)
        )
      );
    }
    return [
      title,
      h(
        "div",
        { class: "hint desc" },
        ex.detail || "A song of the demo project."
      ),
      g.el,
      h(
        "div",
        { class: "hint btn-row" },
        h(
          "button",
          { class: "btn small", onclick: () => playSong(ex) },
          on ? "Stop" : "Play"
        ),
        h(
          "button",
          { class: "btn small", onclick: () => addSong(ex) },
          "Add to project"
        )
      ),
      h(
        "div",
        { class: "hint" },
        `Brings ${ex.instrumentIds.join(", ") || "no instruments"}. An id the project already has gets a free one.`
      ),
    ];
  }

  function sfxInspector(ex: ExampleSfx): HTMLElement[] {
    const title = inspectorTitle(ex.category, ex.name);
    (title.querySelector(".ico") as SVGElement).style.color = categoryColor(
      ex.category
    );
    return [
      title,
      h(
        "div",
        { class: "hint btn-row" },
        h("button", { class: "btn small", onclick: () => playSfx(ex) }, "Play"),
        h(
          "button",
          { class: "btn small", onclick: () => addSfx(ex) },
          "Add to project"
        )
      ),
      h(
        "div",
        { class: "hint" },
        `${chipTheme(ex.chip).short}, ${ex.style}. Add copies it into the project.`
      ),
    ];
  }

  const offEngine = engine.onChange(syncPlaying);
  ctx.cleanup(() => {
    off();
    offEngine();
    fx.dispose();
  });
  build();
  renderInspector();
  ctx.setChip(chip);

  return {
    chip: () => chip,
    play() {
      const song = selectedSong();
      const one = selectedSfx();
      if (song) {
        playSong(song);
      } else if (one) {
        playSfx(one);
      }
    },
  };
}
