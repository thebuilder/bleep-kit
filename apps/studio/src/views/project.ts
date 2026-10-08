/* The project view: settings, export settings, a live preview of the generated audio.ts, the Export button with a
   progress bar, and the list of what changed since the last export. In the standalone studio it also holds the zip
   import and export of the whole project. */
import type { Command, ViewHooks } from "../app.ts";
import { app } from "../app.ts";
import { engine } from "../engine/engine.ts";
import type { ExportResult } from "../export-local.ts";
import {
  type Manifest,
  manifestTs,
  previewManifest,
} from "../export-preview.ts";
import { CHIP_THEME } from "../lib/chips.ts";
import {
  CHIP_IDS,
  type ChipId,
  type Instrument,
  type Project,
  type Sfx,
  type Song,
} from "../lib/contract.ts";
import { choose, debounce, fire, h, prefs } from "../lib/dom.ts";
import {
  audioExportBusy,
  exportAudio,
  exportProjectZip,
  importFiles,
  startOver,
} from "../project-actions.ts";
import type { ViewCtx } from "../shell.ts";
import { project } from "../state/docs.ts";
import type { FileEntry } from "../store/store.ts";
import { nextSteps } from "../ui/empty-state.ts";
import {
  inspectorTitle,
  rangeField,
  selectField,
  textField,
  toggleField,
} from "../ui/fields.ts";
import { icon } from "../ui/icons.ts";

const EVENTS_EXT = /\.events$/;
const LAST_EXT = /\.[^.]+$/;
const LEADING_DOTDOT = /^(\.\.\/)+/;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Colour the preview's TypeScript a little: comments, strings, keywords. */
export function highlightTs(src: string): string {
  const token =
    /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*")|\b(import|export|const|type|as|from|keyof|typeof)\b|(-?\b\d+(?:\.\d+)?\b)/g;
  let out = "";
  let last = 0;
  for (const m of src.matchAll(token)) {
    out += esc(src.slice(last, m.index));
    const cls = choose(
      [
        [m[1] !== undefined, "c"],
        [m[2] !== undefined, "s"],
        [m[3] !== undefined, "k"],
      ],
      "n"
    );
    out += `<i class="${cls}">${esc(m[0])}</i>`;
    last = (m.index ?? 0) + m[0].length;
  }
  return out + esc(src.slice(last));
}

interface Stale {
  id: string;
  kind: "sfx" | "song";
  reason: string;
}

type Doc = ReturnType<typeof project.list>[number];

interface StaleState {
  files: FileEntry[];
  local: boolean;
  seen: Record<string, string>;
}

/** The newest render time per sound id, read from the files under out/. */
function renderTimes(files: FileEntry[]): Map<string, number> {
  const outs = new Map<string, number>();
  for (const f of files) {
    if (f.kind === "render") {
      const base = (f.path.split("/").pop() ?? "")
        .replace(LAST_EXT, "")
        .replace(EVENTS_EXT, "");
      outs.set(base, Math.max(outs.get(base) ?? 0, f.mtime));
    }
  }
  return outs;
}

/** Compared with what the last zip export saw (the browser has no out/ folder to look at). */
function exportReason(d: Doc, seen: Record<string, string>): string | null {
  if (seen[d.path] === d.etag) {
    return null;
  }
  return seen[d.path] ? "changed since the last export" : "never exported";
}

/** Compared with the render files the studio server wrote. */
function renderReason(
  d: Doc,
  outs: Map<string, number>,
  mtime: number
): string | null {
  const o = outs.get(d.id);
  if (o === undefined) {
    return "no render yet";
  }
  return mtime > o ? "changed since its render" : null;
}

function staleList(st: StaleState): Stale[] {
  const outs = renderTimes(st.files);
  const mtimes = new Map(st.files.map((f) => [f.path, f.mtime]));
  const reasonFor = (d: Doc): string | null => {
    if (d.dirty) {
      return "unsaved changes";
    }
    return st.local || outs.size === 0
      ? exportReason(d, st.seen)
      : renderReason(d, outs, mtimes.get(d.path) ?? 0);
  };
  const out: Stale[] = [];
  for (const kind of ["sfx", "song"] as const) {
    for (const d of project.list(kind)) {
      const reason = reasonFor(d);
      if (reason) {
        out.push({ id: d.id, kind, reason });
      }
    }
  }
  return out;
}

function staleChip(s: Stale): HTMLElement {
  const c = h("button", {
    class: "stale-chip",
    onclick: () => app.navigate(`#/${s.kind}/${s.id}`),
    title: s.reason,
  });
  c.innerHTML = `${icon(s.kind === "sfx" ? "wave" : "song", 12)}<span></span><small></small>`;
  (c.querySelector("span") as HTMLElement).textContent = s.id;
  (c.querySelector("small") as HTMLElement).textContent = s.reason;
  return c;
}

const kb = (bytes: number, digits = 1) =>
  `${(bytes / 1024).toFixed(digits)} kB`;

/** What the zip export in the browser produced: the file list, then its notes. */
function browserResultNodes(res: ExportResult): HTMLElement[] {
  const list = h("ul", { class: "files" });
  for (const e of res.entries) {
    const li = h("li", {});
    li.innerHTML = `<span class="mono"></span><small></small>`;
    (li.querySelector("span") as HTMLElement).textContent = e.path;
    (li.querySelector("small") as HTMLElement).textContent = kb(e.data.length);
    list.append(li);
  }
  return [
    h(
      "p",
      { class: "ok" },
      `Exported ${res.entries.length} files (${kb(res.bytes, 0)}). The zip was downloaded.`
    ),
    list,
    ...res.notes.map((n) => h("p", { class: "warnline" }, n)),
  ];
}

interface ServerResult {
  errors?: string[];
  files?: unknown[];
  warnings?: string[];
  written?: unknown[];
}

/** The studio server reports files as paths or as objects with a path or file; show whichever it sent. */
function serverFileNames(r: ServerResult | null): string[] {
  const list = r?.files ?? r?.written ?? [];
  return list.map((f) => {
    if (typeof f === "string") {
      return f;
    }
    const o = f as { file?: string; path?: string } | null;
    return String(o?.path ?? o?.file ?? JSON.stringify(f));
  });
}

export function serverResultNodes(res: unknown): HTMLElement[] {
  const r = res as ServerResult | null;
  const names = serverFileNames(r);
  const body = names.length
    ? h(
        "ul",
        { class: "files" },
        ...names.map((n) => h("li", {}, h("span", { class: "mono" }, n)))
      )
    : h("pre", { class: "json" }, JSON.stringify(res, null, 2));
  return [
    h(
      "p",
      { class: "ok" },
      `Export finished: ${names.length ? `${names.length} files written` : "see the result below"}.`
    ),
    body,
    ...(r?.warnings ?? []).map((w) => h("p", { class: "warnline" }, w)),
    ...(r?.errors ?? []).map((w) => h("p", { class: "bad" }, w)),
  ];
}

export function mountProject(ctx: ViewCtx): ViewHooks {
  const { host, insp } = ctx;
  const { store } = project;
  const local = store.mode === "local";
  let files: FileEntry[] = [];
  const exportedKey = `exported:${project.root}`;
  const exported = () => prefs.get<Record<string, string>>(exportedKey, {});

  host.innerHTML = `
    <div class="proj-view">
      <div class="ed-head">
        <div class="ed-title"><span class="big-ico">${icon("folder", 22)}</span><div><h1 class="vh" id="pName"></h1><small class="muted mono" id="pWhere"></small></div></div>
      </div>
      <div class="proj-grid">
        <section class="card" id="pSettings"><div class="card-h"><h3 class="pxh">Project</h3></div><div class="card-b fields two" id="pSetB"></div></section>
        <section class="card" id="pExportSet"><div class="card-h"><h3 class="pxh">Export settings</h3></div><div class="card-b fields two" id="pExpB"></div></section>
        <section class="card wide-card export-card" id="pExport">
          <div class="card-h"><h3 class="pxh">Export</h3><span class="muted" id="pExpSub"></span></div>
          <div class="card-b">
            <div class="export-row">
              <button class="btn primary big" id="pGo">${icon("export", 16)}<span>Export now</span></button>
              <div class="progress" id="pProg" hidden><i id="pBar"></i><span class="mono" id="pLabel"></span></div>
            </div>
            <div class="export-out" id="pOut"></div>
            <div class="stale" id="pStale"></div>
          </div>
        </section>
        <section class="card wide-card" id="pPreview">
          <div class="card-h"><h3 class="pxh">audio.ts</h3><span class="muted" id="pPrevSub"></span><button class="btn small" id="pCopy">${icon("copy", 12)}<span>Copy</span></button></div>
          <pre class="code" id="pCode" aria-label="Generated audio.ts"></pre>
        </section>
        <section class="card wide-card" id="pLocal" hidden>
          <div class="card-h"><h3 class="pxh">This browser</h3><span class="muted">There is no studio server, so the project lives in this browser. Download a zip now and then to keep a copy.</span></div>
          <div class="card-b btn-row">
            <button class="btn" id="pZipOut">${icon("export", 14)}<span>Download project zip</span></button>
            <label class="btn" for="pZipIn">${icon("import", 14)}<span>Import zip or JSON</span></label><input type="file" id="pZipIn" accept=".zip,.json,application/zip,application/json" hidden multiple>
            <button class="btn danger" id="pReset">${icon("refresh", 14)}<span>Start over with the starter kit</span></button>
          </div>
        </section>
      </div>
    </div>`;
  const q = <T extends HTMLElement>(sel: string) =>
    host.querySelector(sel) as T;
  q("#pLocal").hidden = !local;
  q("#pWhere").textContent = local
    ? "stored in this browser (IndexedDB)"
    : store.label;

  /* ----- settings ----- */
  const edit = (fn: (p: Project) => void, key: string) =>
    project.editProject(fn, key);
  const p0 = project.project;
  const setB = q("#pSetB");
  textField(setB, {
    label: "Name",
    onInput: (v) =>
      edit((p) => {
        p.name = v;
      }, "name"),
    value: p0.name,
  });
  selectField<ChipId>(setB, {
    label: "Default chip",
    onInput: (v) => {
      edit((p) => {
        p.chip = v;
      }, "chip");
      ctx.setChip(v);
    },
    options: CHIP_IDS.map((c) => ({ label: CHIP_THEME[c].short, value: c })),
    value: p0.chip,
  });
  selectField<"44100" | "48000">(setB, {
    label: "Sample rate",
    onInput: (v) =>
      edit((p) => {
        p.sampleRate = Number(v) as 44100 | 48000;
      }, "rate"),
    options: ["48000", "44100"],
    value: String(p0.sampleRate) as "44100" | "48000",
  });
  rangeField(setB, {
    label: "Seed",
    max: 99_999,
    min: 1,
    onInput: (v) =>
      edit((p) => {
        p.seed = Math.round(v);
      }, "seed"),
    step: 1,
    title: "New and mutated sounds derive from this seed",
    value: p0.seed,
  });
  rangeField(setB, {
    label: "Master volume",
    max: 1,
    min: 0,
    onInput: (v) => {
      edit((p) => {
        p.master.volume = v;
      }, "mvol");
      engine.setMaster({ volume: v });
    },
    step: 0.01,
    value: p0.master.volume,
  });
  toggleField(setB, {
    label: "Limiter",
    onInput: (v) => {
      edit((p) => {
        p.master.limiter = v;
      }, "lim");
      engine.setMaster({ limiter: v });
    },
    value: p0.master.limiter,
  });

  const expB = q("#pExpB");
  const e0 = p0.export;
  const E =
    <K extends keyof Project["export"]>(key: K) =>
    (v: Project["export"][K]) =>
      edit(
        (p) => {
          p.export[key] = v;
        },
        `exp-${String(key)}`
      );
  textField(expB, {
    label: "Audio folder",
    onInput: E("dir"),
    placeholder: "../public/audio",
    value: e0.dir,
  });
  textField(expB, {
    label: "Manifest file",
    onInput: E("manifest"),
    placeholder: "../src/audio.ts",
    value: e0.manifest,
  });
  textField(expB, {
    label: "URL prefix",
    onInput: E("baseUrl"),
    placeholder: "/audio/",
    value: e0.baseUrl,
  });
  selectField<"wav" | "ogg" | "mp3">(expB, {
    label: "SFX format",
    onInput: E("sfxFormat"),
    options: ["ogg", "wav", "mp3"],
    value: e0.sfxFormat,
  });
  selectField<"wav" | "ogg" | "mp3">(expB, {
    label: "Music format",
    onInput: E("musicFormat"),
    options: ["ogg", "wav", "mp3"],
    value: e0.musicFormat,
  });
  rangeField(expB, {
    label: "OGG quality",
    max: 10,
    min: -1,
    onInput: (v) => E("oggQuality")(Math.round(v)),
    step: 1,
    value: e0.oggQuality,
  });
  rangeField(expB, {
    label: "MP3 kbps",
    max: 320,
    min: 64,
    onInput: (v) => E("mp3Bitrate")(Math.round(v)),
    step: 16,
    value: e0.mp3Bitrate,
  });
  toggleField(expB, {
    label: "Events files",
    onInput: E("events"),
    value: e0.events,
  });
  toggleField(expB, {
    label: "Embed documents",
    onInput: E("embed"),
    value: e0.embed,
  });
  expB.append(
    h(
      "p",
      { class: "hint wide", style: "grid-column:1/-1" },
      "Embedding puts the sounds themselves in audio.ts, so the game can synthesize them with no audio files at all. That is the best choice for Safari, which cannot decode OGG."
    )
  );

  /* ----- preview ----- */
  const code = q("#pCode");
  let manifestText = "";
  function renderPreview(): void {
    const p = project.project;
    const m: Manifest = previewManifest(
      p,
      project.list("sfx").map((d) => ({ id: d.id, value: d.value as Sfx })),
      project.list("song").map((d) => ({ id: d.id, value: d.value as Song })),
      project.instruments() as Record<string, Instrument>
    );
    manifestText = manifestTs(m);
    code.innerHTML = highlightTs(manifestText);
    q("#pPrevSub").textContent =
      `${Object.keys(m.sfx).length} sfx, ${Object.keys(m.songs).length} songs. Durations are estimates until you export.`;
    q("#pName").textContent = p.name;
    q("#pExpSub").textContent = local
      ? `Renders in this browser and downloads a zip with ${p.export.dir.replace(LEADING_DOTDOT, "")} and ${p.export.manifest.replace(LEADING_DOTDOT, "")}`
      : `The studio server writes to ${p.export.dir}`;
  }
  const preview = debounce(renderPreview, 120);
  q("#pCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(manifestText);
      app.toast("Copied audio.ts");
    } catch {
      app.toast("Could not copy: select the text and copy it");
    }
  });

  /* ----- stale list ----- */
  function renderStale(): void {
    const box = q("#pStale");
    box.replaceChildren();
    const list = staleList({ files, local, seen: exported() });
    const total = project.list("sfx").length + project.list("song").length;
    if (total === 0) {
      box.append(
        h(
          "div",
          { class: "stale-h" },
          h("b", { class: "pxh" }, "Nothing to export yet")
        ),
        h(
          "p",
          { class: "muted" },
          "This project has no sound effects or songs. Add something, then export it for your game."
        ),
        nextSteps()
      );
      return;
    }
    const head = h("div", { class: "stale-h" });
    head.innerHTML = `<b class="pxh"></b><span class="muted"></span>`;
    (head.querySelector("b") as HTMLElement).textContent = list.length
      ? `Stale (${list.length} of ${total})`
      : "Everything is up to date";
    (head.querySelector("span") as HTMLElement).textContent = list.length
      ? "These changed since they were last exported."
      : `${total} sounds exported.`;
    box.append(head);
    const chips = h("div", { class: "stale-chips" }, ...list.map(staleChip));
    box.append(chips);
  }
  async function refreshFiles(): Promise<void> {
    try {
      files = await project.store.list();
    } catch {
      files = [];
    }
    renderStale();
  }

  /* ----- export ----- */
  const go = q<HTMLButtonElement>("#pGo");
  const prog = q("#pProg");
  const bar = q("#pBar");
  const progLabel = q("#pLabel");
  const outBox = q("#pOut");
  async function runExport(): Promise<void> {
    if (audioExportBusy()) {
      return;
    }
    go.disabled = true;
    outBox.replaceChildren();
    prog.hidden = false;
    prog.classList.remove("indeterminate");
    bar.style.width = "0%";
    try {
      const out = await exportAudio({
        progress: (done, total, label) => {
          bar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
          progLabel.textContent = `${label}  ${done}/${total}`;
        },
        serverStarted: () => {
          prog.classList.add("indeterminate");
          progLabel.textContent = "The studio server is rendering";
        },
      });
      bar.style.width = "100%";
      if (out.mode === "browser") {
        progLabel.textContent = "done";
        outBox.append(...browserResultNodes(out.res));
      } else {
        outBox.append(...serverResultNodes(out.res));
      }
    } catch (err) {
      outBox.append(
        h("p", { class: "bad" }, `Export failed: ${(err as Error).message}`)
      );
    } finally {
      go.disabled = false;
      setTimeout(() => {
        prog.hidden = true;
      }, 1500);
      fire(refreshFiles());
    }
  }
  go.addEventListener("click", () => fire(runExport()));

  /* ----- local-only actions (the project menu in the top bar has the same ones) ----- */
  if (local) {
    q("#pZipOut").addEventListener("click", () => fire(exportProjectZip()));
    q<HTMLInputElement>("#pZipIn").addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      const picked = Array.from(input.files ?? []);
      input.value = "";
      fire(importFiles(picked, "#/project"));
    });
    q("#pReset").addEventListener("click", () => fire(startOver()));
  }

  /* ----- inspector ----- */
  function buildInspector(): void {
    insp.replaceChildren();
    const inner = h("div", { class: "insp-in" });
    insp.append(inner);
    inner.append(inspectorTitle("folder", project.project.name));
    const stats = h("div", { class: "hint stats-list" });
    for (const [label, n] of [
      ["Sound effects", project.list("sfx").length],
      ["Songs", project.list("song").length],
      ["Instruments", project.list("instrument").length],
    ] as const) {
      const row = h("div", { class: "kv" });
      row.innerHTML = `<span></span><b class="mono"></b>`;
      (row.querySelector("span") as HTMLElement).textContent = label;
      (row.querySelector("b") as HTMLElement).textContent = String(n);
      stats.append(row);
    }
    inner.append(stats);
    const fld = h("div", { class: "grp-b" });
    toggleField(fld, {
      label: "Autosave",
      onInput: (v) => project.setAutosave(v),
      value: project.autosave,
    });
    inner.append(h("div", { class: "hint" }, fld));
    inner.append(
      h(
        "div",
        { class: "hint" },
        "Changes are saved 800 ms after you stop. Ctrl+S saves right away, Ctrl+E brings you here to export."
      )
    );
  }

  const unsub = project.subscribe((e) => {
    if (
      e.type === "project" ||
      e.type === "list" ||
      (e.type === "doc" && e.cause !== "saved")
    ) {
      preview();
    }
    if (e.type === "doc" || e.type === "list") {
      renderStale();
    }
    if (e.type === "list") {
      buildInspector();
    }
  });
  buildInspector();
  renderPreview();
  renderStale();
  fire(refreshFiles());
  ctx.cleanup(() => {
    unsub();
    preview.cancel();
  });
  if (ctx.route.view === "project" && ctx.route.export) {
    const card = q("#pExport");
    card.classList.add("spot");
    requestAnimationFrame(() => {
      card.scrollIntoView({ block: "center" });
      go.focus();
    });
  }
  const commands = (): Command[] => [
    {
      group: "Project",
      icon: "export",
      id: "proj:export",
      keys: "Ctrl E",
      run: () => fire(runExport()),
      title: "Export now",
    },
  ];
  return { chip: () => project.project.chip, commands };
}
