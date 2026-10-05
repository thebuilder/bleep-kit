/* The shell: top bar with transport, the sidebar, the stage with the master strip, the inspector, overlays, global
   shortcuts, the router and the boot sequence. Views are mounted into #view and #insp by the router. */
import {
  app,
  type Command,
  parseRoute,
  type Route,
  routeHash,
  type ViewHooks,
} from "./app.ts";
import { type Backdrop, createBackdrop } from "./backdrop/index.ts";
import { engine } from "./engine/engine.ts";
import { chipTheme } from "./lib/chips.ts";
import type { ChipId } from "./lib/contract.ts";
import { choose, fire, formatTime, h, prefs } from "./lib/dom.ts";
import { playRef, stopEverything } from "./playback.ts";
import { type Doc, project } from "./state/docs.ts";
import { LocalStore } from "./store/local.ts";
import { probeServer, ServerStore } from "./store/server.ts";
import type { ProjectStore } from "./store/store.ts";
import { openHelp } from "./ui/help.ts";
import { icon } from "./ui/icons.ts";
import { modalOpen } from "./ui/modal.ts";
import { openPalette } from "./ui/palette.ts";
import {
  createInstrument,
  createSfx,
  createSong,
  pickCategory,
  pickKind,
} from "./ui/pickers.ts";
import { createSidebar } from "./ui/sidebar.ts";
import { mountAnalysis } from "./views/analysis.ts";
import { mountInstrument } from "./views/instrument.ts";
import { mountPads } from "./views/pads.ts";
import { mountProject } from "./views/project.ts";
import { mountSfx } from "./views/sfx.ts";
import { mountSong } from "./views/song.ts";
import { addVisual, startLoop, tickOnce } from "./visuals/loop.ts";
import { createStrip, type Strip } from "./visuals/strip.ts";

export interface ViewCtx {
  /** Run when the view is unmounted. */
  cleanup: (fn: () => void) => void;
  host: HTMLElement;
  insp: HTMLElement;
  route: Route;
  /** Set the chip the badge and backdrop follow. */
  setChip: (chip: ChipId) => void;
}

const LOGO = `<svg class="logo" viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true"><rect width="8" height="8" fill="#0b0a10"/><rect data-b="0" x="1" y="4" width="1" height="3" fill="#7d97dc"/><rect data-b="1" x="3" y="2" width="1" height="5" fill="#f3b24a"/><rect data-b="2" x="5" y="3" width="1" height="4" fill="#74c08f"/><rect data-b="3" x="7" y="1" width="1" height="1" fill="#ece7da"/></svg>`;

const KIND_GROUP = {
  instrument: "Instrument",
  sfx: "SFX",
  song: "Song",
} as const;
const KIND_ICON = {
  instrument: "instrument",
  sfx: "blip",
  song: "song",
} as const;

/** The browser tab title for a route. */
function titleOf(r: Route): string {
  return choose(
    [
      [r.view === "pads", "Pads"],
      [r.view === "project", "Project"],
      ["id" in r, "id" in r ? r.id : ""],
    ],
    "Analysis"
  );
}

const LOGO_AMP = [5, 6, 5, 4];
const logoBarHeight = (level: number, i: number, time: number): number =>
  Math.max(
    1,
    Math.round(
      1 +
        level *
          (LOGO_AMP[i] ?? 4) *
          (0.6 + 0.4 * Math.sin(time / 140 + i * 1.7))
    )
  );

export async function boot(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="app" id="shell">
      <header class="top">
        <button class="btn icon ghost menu-btn" id="menuBtn" aria-label="Project tree">${icon("menu", 16)}</button>
        <a class="brand" href="#/pads">${LOGO}<span>BLEEPKIT</span><small>studio</small></a>
        <div class="transport">
          <button class="btn icon" id="tStop" title="Stop (Esc)" aria-label="Stop">${icon("stop", 16)}</button>
          <button class="btn icon primary" id="tPlay" title="Play (Space)" aria-label="Play">${icon("play", 16)}</button>
          <div class="lcd dim" id="lcdTime"><span id="tTime">00:00.000</span><span class="pos" id="tPos">ORD -- ROW --</span></div>
          <div class="lcd dim cpu" id="lcdCpu"><small id="tCpu">CPU --</small><small id="tLat">LAT --</small></div>
        </div>
        <div class="status">
          <div class="chip-badge" id="chipBadge"></div>
          <button class="btn icon small" id="bUndo" title="Undo (Ctrl+Z)" aria-label="Undo">${icon("undo", 14)}</button>
          <button class="btn icon small" id="bRedo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">${icon("redo", 14)}</button>
          <div class="savestate" id="saveState"><i></i><span>Saved</span></div>
          <button class="btn icon small" id="bPal" title="Command palette (Ctrl+K)" aria-label="Command palette">${icon("search", 14)}</button>
          <button class="btn icon small" id="bHelp" title="Shortcuts (?)" aria-label="Shortcuts">?</button>
        </div>
      </header>
      <aside class="side" id="side" aria-label="Project"></aside>
      <main class="stage" id="stage">
        <div class="strip" id="strip"></div>
        <div class="cbar" id="cbar" hidden></div>
        <div id="view"></div>
      </main>
      <aside class="insp" id="insp" aria-label="Inspector"></aside>
    </div>
    <button id="audioPill" hidden>${icon("speaker", 16)}<span>Click to enable audio</span></button>
    <div id="toast" hidden></div>`;
  const q = <T extends HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  app.bindToast(q("toast"));
  const backdrop: Backdrop = createBackdrop(q<HTMLCanvasElement>("backdrop"));
  const strip: Strip = createStrip(q("strip"));
  const sidebar = createSidebar(q("side"));
  app.openPalette = () => openPalette(allCommands());
  app.openHelp = openHelp;
  app.openMenu = (on) => document.body.classList.toggle("menu-open", on);

  /* ----- engine and project ----- */
  await engine.init();
  if (import.meta.env?.DEV) {
    (window as unknown as { __bleepkit?: unknown }).__bleepkit = {
      engine,
      project,
    };
  }
  startLoop();
  const store = await openStore();
  project.onRemotePlay = playRef;
  project.onLog = (level, message) => {
    if (level !== "info") {
      app.toast(message);
    }
  };
  try {
    await project.load(store);
  } catch (err) {
    app.toast(`Could not open the project: ${(err as Error).message}`);
  }
  backdrop.setChip(project.project.chip);
  strip.setChip(project.project.chip);

  /* ----- transport and status ----- */
  const bars = [
    ...document.querySelectorAll<SVGRectElement>(".logo rect[data-b]"),
  ];
  const lcdTime = q("lcdTime");
  const tTime = q("tTime");
  const tPos = q("tPos");
  const tCpu = q("tCpu");
  const tLat = q("tLat");
  const tPlay = q("tPlay");
  const animateLogo = (f: {
    level: number;
    reduced: boolean;
    time: number;
  }) => {
    // the logo bars breathe with the level
    const lv = Math.min(1, f.level * 3.5);
    for (const [i, b] of bars.entries()) {
      const hgt = f.reduced
        ? ([3, 5, 4, 1][i] ?? 2)
        : logoBarHeight(lv, i, f.time);
      b.setAttribute("height", String(hgt));
      b.setAttribute("y", String(7 - hgt));
    }
  };
  let lastText = "";
  let lastPlay = "";
  addVisual((f) => {
    const active = engine.playing || f.level > 0.003;
    const secs = engine.playing ? engine.songSeconds() : 0;
    const p = f.position;
    const text = `${formatTime(secs)}|${p ? `ORD ${String(p.order).padStart(2, "0")} ROW ${String(p.row).padStart(2, "0")}` : "ORD -- ROW --"}`;
    if (text !== lastText) {
      lastText = text;
      const [a = "", b = ""] = text.split("|");
      tTime.textContent = a;
      tPos.textContent = b;
    }
    lcdTime.classList.toggle("dim", !active);
    const cpu = choose(
      [
        [engine.cpu > 0, `CPU ${Math.round(engine.cpu * 100)}%`],
        [engine.fake, "FAKE ENGINE"],
      ],
      "CPU --"
    );
    if (tCpu.textContent !== cpu) {
      tCpu.textContent = cpu;
    }
    const lat = engine.latencyMs ? `LAT ${engine.latencyMs}ms` : "LAT --";
    if (tLat.textContent !== lat) {
      tLat.textContent = lat;
    }
    const playIcon = engine.playing ? "pause" : "play";
    if (playIcon !== lastPlay) {
      lastPlay = playIcon;
      tPlay.innerHTML = icon(playIcon, 16);
    }
    animateLogo(f);
  });
  const syncStatus = () => {
    const el = q("saveState");
    const d = app.currentDoc();
    const errs = d?.issues.filter((i) => i.severity === "error").length ?? 0;
    const dirty = project.dirtyCount > 0;
    el.className = `savestate${choose(
      [
        [errs > 0, " err"],
        [dirty, " dirty"],
      ],
      ""
    )}`;
    (el.querySelector("span") as HTMLElement).textContent = choose(
      [
        [errs > 0, `${errs} error${errs > 1 ? "s" : ""}`],
        [dirty && project.autosave, "Saving soon"],
        [dirty, "Unsaved"],
      ],
      "Saved"
    );
    const undoBtn = q<HTMLButtonElement>("bUndo");
    const redoBtn = q<HTMLButtonElement>("bRedo");
    undoBtn.disabled = !d?.history.canUndo;
    redoBtn.disabled = !d?.history.canRedo;
    renderConflict();
  };
  const renderConflict = () => {
    const bar = q("cbar");
    const d = app.currentDoc();
    if (!d?.conflict) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.replaceChildren(
      h("span", {}, `${d.id} changed on disk while you had unsaved edits.`),
      h(
        "button",
        { class: "btn small", onclick: () => project.reload(d) },
        "Reload"
      ),
      h(
        "button",
        {
          class: "btn small primary",
          onclick: () => fire(project.keepMine(d)),
        },
        "Keep mine"
      )
    );
  };
  project.subscribe((e) => {
    if (e.type === "doc" || e.type === "project" || e.type === "list") {
      syncStatus();
    }
    if (e.type === "project") {
      const chip = currentChip();
      backdrop.setChip(chip);
      strip.setChip(chip);
      renderBadge(chip);
    }
  });

  /* ----- chip badge ----- */
  let badgeChip: ChipId | "" = "";
  function renderBadge(chip: ChipId): void {
    if (chip === badgeChip) {
      return;
    }
    badgeChip = chip;
    const el = q("chipBadge");
    el.innerHTML = `${icon(chip, 16)}<span>${chipTheme(chip).short}</span>`;
  }
  const currentChip = (): ChipId => app.hooks.chip?.() ?? project.project.chip;

  /* ----- audio pill ----- */
  const pill = q("audioPill");
  const syncPill = () => {
    pill.hidden = engine.status !== "locked";
  };
  engine.onChange(syncPill);
  syncPill();
  pill.addEventListener("click", () => fire(engine.unlock()));
  document.addEventListener("pointerdown", () => fire(engine.unlock()), {
    capture: true,
  });
  document.addEventListener("keydown", () => fire(engine.unlock()), {
    capture: true,
  });

  /* ----- buttons ----- */
  q("tStop").addEventListener("click", stopEverything);
  tPlay.addEventListener("click", () => togglePlay());
  q("bUndo").addEventListener("click", () => app.undo());
  q("bRedo").addEventListener("click", () => app.redo());
  q("bPal").addEventListener("click", () => app.openPalette());
  q("bHelp").addEventListener("click", () => openHelp());
  q("menuBtn").addEventListener("click", () =>
    app.openMenu(!document.body.classList.contains("menu-open"))
  );
  q("side").addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("a")) {
      app.openMenu(false);
    }
  });

  function togglePlay(): void {
    if (app.hooks.play) {
      app.hooks.play();
    } else if (engine.playing) {
      engine.pauseSong();
    }
  }

  /* ----- commands ----- */
  function docNeighbors(step: number): void {
    const all: Doc[] = [
      ...project.list("sfx"),
      ...project.list("song"),
      ...project.list("instrument"),
    ];
    if (!all.length) {
      return;
    }
    const cur = app.currentDoc();
    const i = cur ? all.findIndex((d) => d.path === cur.path) : -1;
    const next = all[(i + step + all.length) % all.length];
    if (next) {
      app.navigate(`#/${next.kind}/${next.id}`);
    }
  }
  function openAnalysis(): void {
    const d = app.currentDoc() ?? project.list("sfx")[0] ?? null;
    if (d && d.kind !== "instrument") {
      app.navigate(`#/analysis/${d.kind}/${d.id}`);
    } else if (d) {
      app.toast("Analysis is for sound effects and songs");
    }
  }
  function allCommands(): Command[] {
    const cmds: Command[] = [
      {
        group: "Transport",
        icon: "play",
        id: "play",
        keys: "Space",
        run: togglePlay,
        title: "Play or pause",
      },
      {
        group: "Transport",
        icon: "stop",
        id: "stop",
        keys: "Esc",
        run: stopEverything,
        title: "Stop everything",
      },
      {
        group: "File",
        icon: "save",
        id: "save",
        keys: "Ctrl S",
        run: () => fire(app.save()),
        title: "Save",
      },
      {
        group: "Edit",
        icon: "undo",
        id: "undo",
        keys: "Ctrl Z",
        run: () => app.undo(),
        title: "Undo",
      },
      {
        group: "Edit",
        icon: "redo",
        id: "redo",
        keys: "Ctrl Shift Z",
        run: () => app.redo(),
        title: "Redo",
      },
      {
        group: "Go",
        icon: "pads",
        id: "pads",
        run: () => app.navigate("#/pads"),
        title: "Go to pads",
      },
      {
        group: "Go",
        icon: "folder",
        id: "project",
        run: () => app.navigate("#/project"),
        title: "Go to project and export",
      },
      {
        group: "Go",
        icon: "chart",
        id: "analysis",
        keys: "Ctrl Shift A",
        run: openAnalysis,
        title: "Analyse the current document",
      },
      {
        group: "File",
        icon: "export",
        id: "export",
        keys: "Ctrl E",
        run: () => app.navigate("#/project?export=1"),
        title: "Export the project",
      },
      {
        group: "Go",
        icon: "right",
        id: "next",
        keys: "]",
        run: () => docNeighbors(1),
        title: "Next document",
      },
      {
        group: "Go",
        icon: "left",
        id: "prev",
        keys: "[",
        run: () => docNeighbors(-1),
        title: "Previous document",
      },
      {
        group: "New",
        icon: "plus",
        id: "new-sfx",
        run: () =>
          pickCategory((c) =>
            fire(createSfx(c, { navigate: app.route.view !== "pads" }))
          ),
        title: "New sound effect",
      },
      {
        group: "New",
        icon: "plus",
        id: "new-song",
        run: () => fire(createSong()),
        title: "New song",
      },
      {
        group: "New",
        icon: "plus",
        id: "new-inst",
        run: () => pickKind((k) => fire(createInstrument(k))),
        title: "New instrument",
      },
      {
        group: "File",
        icon: "save",
        id: "autosave",
        run: () => project.setAutosave(!project.autosave),
        title: `Autosave: turn ${project.autosave ? "off" : "on"}`,
      },
      {
        group: "Help",
        icon: "info",
        id: "help",
        keys: "?",
        run: openHelp,
        title: "Keyboard shortcuts",
      },
      {
        enabled: () => !!app.currentDoc(),
        group: "File",
        icon: "copy",
        id: "dup",
        run: () => {
          const d = app.currentDoc();
          if (d) {
            fire(
              project
                .duplicate(d)
                .then((c) => app.navigate(`#/${c.kind}/${c.id}`))
            );
          }
        },
        title: "Duplicate the current document",
      },
      {
        enabled: () => !!app.currentDoc(),
        group: "File",
        icon: "trash",
        id: "del",
        run: () => {
          const d = app.currentDoc();
          if (d) {
            fire(
              project.remove(d).then(() => {
                app.navigate("#/pads");
                app.toast(`Deleted ${d.id}`);
              })
            );
          }
        },
        title: "Delete the current document",
      },
    ];
    for (const kind of ["sfx", "song", "instrument"] as const) {
      for (const d of project.list(kind)) {
        cmds.push({
          group: KIND_GROUP[kind],
          icon: KIND_ICON[kind],
          id: `open:${d.path}`,
          run: () => app.navigate(`#/${kind}/${d.id}`),
          title: `${(d.value as { name?: string }).name || d.id}`,
        });
      }
    }
    return [...cmds, ...(app.hooks.commands?.() ?? [])];
  }

  /* ----- keyboard ----- */
  const typing = (t: EventTarget | null): boolean => {
    if (!(t instanceof HTMLElement)) {
      return false;
    }
    if (
      t.isContentEditable ||
      t.tagName === "TEXTAREA" ||
      t.tagName === "SELECT"
    ) {
      return true;
    }
    if (t.tagName === "INPUT") {
      const { type } = t as HTMLInputElement;
      return !["range", "checkbox", "radio", "button"].includes(type);
    }
    return false;
  };
  const modShortcut = (e: KeyboardEvent, isTyping: boolean): boolean => {
    const key = e.key.toLowerCase();
    if (key === "k") {
      app.openPalette();
    } else if (key === "s") {
      fire(app.save());
    } else if (key === "e") {
      app.navigate("#/project?export=1");
    } else if (key === "a" && e.shiftKey) {
      openAnalysis();
    } else if ((key === "z" || key === "y") && !isTyping) {
      if (key === "y" || e.shiftKey) {
        app.redo();
      } else {
        app.undo();
      }
    } else {
      return false;
    }
    e.preventDefault();
    return true;
  };
  const onEscape = (e: KeyboardEvent, isTyping: boolean) => {
    if (document.body.classList.contains("menu-open")) {
      app.openMenu(false);
    } else if (!isTyping || (e.target as HTMLElement).tagName !== "TEXTAREA") {
      stopEverything();
    }
  };
  const plainKey = (e: KeyboardEvent) => {
    if (app.hooks.onKey?.(e)) {
      e.preventDefault();
    } else if (e.key === " ") {
      e.preventDefault();
      togglePlay();
    } else if (e.key === "?") {
      openHelp();
    } else if (e.key === "[") {
      docNeighbors(-1);
    } else if (e.key === "]") {
      docNeighbors(1);
    }
  };
  document.addEventListener("keydown", (e) => {
    if (modalOpen()) {
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const isTyping = typing(e.target);
    if (mod && modShortcut(e, isTyping)) {
      return;
    }
    if (e.key === "Escape") {
      onEscape(e, isTyping);
    } else if (!(isTyping || mod || e.altKey)) {
      plainKey(e);
    }
  });

  /* ----- router ----- */
  const cleanups: (() => void)[] = [];
  const host = q("view");
  const insp = q("insp");
  let mountToken = 0;
  function route(): void {
    const r = parseRoute(location.hash);
    mountToken += 1;
    const token = mountToken;
    for (const fn of cleanups.splice(0)) {
      fn();
    }
    app.hooks = {};
    host.replaceChildren();
    insp.replaceChildren();
    app.route = r;
    const ctx: ViewCtx = {
      cleanup: (fn) => cleanups.push(fn),
      host,
      insp,
      route: r,
      setChip: (chip) => {
        backdrop.setChip(chip);
        strip.setChip(chip);
        renderBadge(chip);
      },
    };
    const missing = (kind: "sfx" | "song" | "instrument", id: string) => {
      app.toast(`There is no ${kind} named ${id}`);
      app.navigate("#/pads");
    };
    let hooks: ViewHooks | undefined;
    switch (r.view) {
      case "sfx":
        if (!project.get("sfx", r.id)) {
          missing("sfx", r.id);
          return;
        }
        hooks = mountSfx(ctx, r.id);
        break;
      case "song":
        if (!project.get("song", r.id)) {
          missing("song", r.id);
          return;
        }
        hooks = mountSong(ctx, r.id);
        break;
      case "instrument":
        if (!project.get("instrument", r.id)) {
          missing("instrument", r.id);
          return;
        }
        hooks = mountInstrument(ctx, r.id);
        break;
      case "analysis":
        hooks = mountAnalysis(ctx, r.ref);
        break;
      case "project":
        hooks = mountProject(ctx);
        break;
      default:
        hooks = mountPads(ctx);
    }
    if (token !== mountToken) {
      return;
    }
    app.hooks = hooks ?? {};
    ctx.setChip(currentChip());
    sidebar.update(r);
    syncStatus();
    app.openMenu(false);
    document.title = `${titleOf(r)} - Bleepkit Studio`;
    host.scrollTop = 0;
  }
  addEventListener("hashchange", route);
  if (!location.hash) {
    history.replaceState(null, "", routeHash({ view: "pads" }));
  }
  renderBadge(currentChip());
  route();
  syncStatus();
  tickOnce();
  prefs.set("last-open", Date.now());
}

async function openStore(): Promise<ProjectStore> {
  const params = new URLSearchParams(location.search);
  if (params.get("store") !== "local") {
    const health = await probeServer();
    if (health) {
      return new ServerStore("", health.root ?? "project folder");
    }
  }
  return LocalStore.create();
}
