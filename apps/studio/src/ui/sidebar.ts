/* The left sidebar: view navigation, search, and the project tree (SFX, Songs, Instruments) with a "+ New" per section
   and a play button on every row, so everything is previewable without opening it. */
import { app, type Route } from "../app.ts";
import { categoryColor, KIND_HEX } from "../lib/chips.ts";
import type { Instrument, Sfx, Song } from "../lib/contract.ts";
import { fire, h, prefs } from "../lib/dom.ts";
import { playDoc } from "../playback.ts";
import { type Doc, type DocKind, project } from "../state/docs.ts";
import { icon } from "./icons.ts";
import {
  createInstrument,
  createSfx,
  createSong,
  pickCategory,
  pickKind,
} from "./pickers.ts";

const SECTIONS: { kind: DocKind; title: string; ic: string; empty: string }[] =
  [
    { empty: "No sound effects yet.", ic: "blip", kind: "sfx", title: "SFX" },
    { empty: "No songs yet.", ic: "song", kind: "song", title: "Songs" },
    {
      empty: "No instruments yet.",
      ic: "instrument",
      kind: "instrument",
      title: "Instruments",
    },
  ];

function rowFor(doc: Doc, cur: boolean): HTMLElement {
  let ic = "song";
  let color = "#9a95ad";
  let meta = "";
  if (doc.kind === "sfx") {
    const s = doc.value as Sfx;
    ic = s.category;
    color = categoryColor(s.category);
    meta = `${(s.envelope.attack + s.envelope.sustain + s.envelope.decay).toFixed(2)}s`;
  } else if (doc.kind === "instrument") {
    const i = doc.value as Instrument;
    ic = i.kind;
    color = KIND_HEX[i.kind];
    meta = i.kind;
  } else {
    const s = doc.value as Song;
    meta = `${s.tempo} bpm`;
    color = "#f3b24a";
  }
  const name = (doc.value as { name?: string }).name || doc.id;
  const pl = h("button", {
    "aria-label": `Play ${name}`,
    class: "pl",
    title: "Play",
  });
  pl.innerHTML = icon("play", 12);
  pl.addEventListener("click", (e) => {
    e.stopPropagation();
    playDoc(doc);
  });
  const a = h("a", {
    class: "tl",
    href: `#/${doc.kind}/${encodeURIComponent(doc.id)}`,
    title: doc.id,
  });
  a.innerHTML = `${icon(ic, 16)}<span class="nm"></span>`;
  (a.querySelector(".nm") as HTMLElement).textContent = name;
  const row = h(
    "div",
    {
      class: `tree-item${cur ? " cur" : ""}${doc.dirty ? " dirty" : ""}${Date.now() - doc.flashAt < 900 ? " flash" : ""}`,
      style: `--kc:${color}`,
    },
    a,
    h("span", { class: "meta" }, meta),
    h("i", { class: "dot", title: "Unsaved changes" }),
    pl
  );
  return row;
}

export function createSidebar(host: HTMLElement): {
  update: (route: Route) => void;
} {
  const nav = h("nav", { class: "nav" });
  const links: [string, string, string][] = [
    ["#/pads", "pads", "Pads"],
    ["#/analysis/", "chart", "Analysis"],
    ["#/project", "folder", "Project"],
  ];
  for (const [href, ic, label] of links) {
    const a = h("a", { "data-nav": ic, href });
    a.innerHTML = `${icon(ic, 20)}<span>${label}</span>`;
    nav.append(a);
  }
  const palBtn = h("a", {
    "data-nav": "search",
    href: "#",
    onclick: (e: Event) => {
      e.preventDefault();
      app.openPalette();
    },
  });
  palBtn.innerHTML = `${icon("search", 20)}<span>Find</span>`;
  nav.append(palBtn);

  const input = h("input", {
    "aria-label": "Search the project",
    placeholder: "Search the project",
    type: "search",
  }) as HTMLInputElement;
  const search = h("div", { class: "search" }, input);
  search.insertAdjacentHTML("afterbegin", icon("search", 14));
  const tree = h("div", { class: "tree" });
  host.replaceChildren(h("div", { class: "side-head" }, nav, search), tree);

  const collapsed = new Set<string>(prefs.get("collapsed", [] as string[]));
  let route: Route = { view: "pads" };
  let queued = false;

  const matches = (d: { id: string; value: unknown }, q: string) => {
    const name = ((d.value as { name?: string }).name ?? "").toLowerCase();
    return !q || d.id.includes(q) || name.includes(q);
  };
  const isCurrent = (kind: string, id: string) =>
    (route.view === kind && (route as { id?: string }).id === id) ||
    (route.view === "analysis" && route.ref.endsWith(`/${id}`));
  const onAdd = (kind: string) => {
    if (kind === "sfx") {
      pickCategory((c) =>
        fire(createSfx(c, { navigate: route.view !== "pads" }))
      );
    } else if (kind === "song") {
      fire(createSong());
    } else {
      pickKind((k) => fire(createInstrument(k)));
    }
  };
  const sectionHead = (
    sec: (typeof SECTIONS)[number],
    closed: boolean,
    count: number
  ) => {
    const tw = h("button", {
      "aria-expanded": closed ? "false" : "true",
      class: "tw",
    });
    tw.innerHTML = `${icon(closed ? "right" : "down", 12)}<span class="pxh">${sec.title}</span><span class="count">${count}</span>`;
    tw.addEventListener("click", () => {
      if (collapsed.has(sec.kind)) {
        collapsed.delete(sec.kind);
      } else {
        collapsed.add(sec.kind);
      }
      prefs.set("collapsed", [...collapsed]);
      render();
    });
    const add = h("button", {
      "aria-label": `New ${sec.title}`,
      class: "btn small",
      title: `New ${sec.title}`,
    });
    add.innerHTML = `${icon("plus", 12)}New`;
    add.addEventListener("click", () => onAdd(sec.kind));
    return h("div", { class: "tree-h" }, tw, add);
  };
  const syncNav = () => {
    for (const a of nav.querySelectorAll<HTMLAnchorElement>("a[data-nav]")) {
      const target = a.getAttribute("href") ?? "";
      const on =
        (route.view === "pads" && target === "#/pads") ||
        (route.view === "project" && target === "#/project") ||
        (route.view === "analysis" && target.startsWith("#/analysis"));
      a.classList.toggle("cur", on);
    }
  };

  function render(): void {
    queued = false;
    const q = input.value.trim().toLowerCase();
    const out: HTMLElement[] = [];
    for (const sec of SECTIONS) {
      const docs = project.list(sec.kind).filter((d) => matches(d, q));
      const closed = collapsed.has(sec.kind) && !q;
      const secEl = h(
        "section",
        { class: "tree-sec" },
        sectionHead(sec, closed, docs.length)
      );
      if (!closed) {
        if (docs.length === 0) {
          secEl.append(
            h(
              "div",
              { class: "tree-empty" },
              q ? "Nothing matches." : sec.empty
            )
          );
        }
        for (const d of docs) {
          secEl.append(rowFor(d, isCurrent(sec.kind, d.id)));
        }
      }
      out.push(secEl);
    }
    tree.replaceChildren(...out);
    syncNav();
  }
  const schedule = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(render);
    }
  };
  input.addEventListener("input", schedule);
  project.subscribe((e) => {
    if (e.type === "list" || e.type === "doc") {
      schedule();
    }
  });
  render();
  return {
    update(r) {
      route = r;
      render();
    },
  };
}
