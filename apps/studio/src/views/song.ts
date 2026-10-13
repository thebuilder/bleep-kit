/* The song editor: a Famitracker style tracker grid (one column per channel, colored by kind), an order list, tempo and
   rows per beat, per-channel scopes, mute and solo, an optional Text (MML) view per channel with live error underlines, and a
   four octave strip that lights with the notes that play. The right-hand inspector holds the song and the selected channel. */
import type { Command, ViewHooks } from "../app.ts";
import { app } from "../app.ts";
import { engine } from "../engine/engine.ts";
import { CHIP_THEME, KIND_COLOR, KIND_HEX, KIND_LABEL } from "../lib/chips.ts";
import {
  CHIP_IDS,
  type ChipId,
  type Effect,
  type EngineEvent,
  type Instrument,
  type NoteValue,
  type Pattern,
  type Row,
  type Song,
  type SongChannel,
} from "../lib/contract.ts";
import {
  chipChannels,
  chipProfile,
  formatEffect,
  noteName,
  orderStartRow,
  parseEffect,
  parseMml,
  patternToMml,
  songTiming,
} from "../lib/core.ts";
import { choose, clamp, debounce, fire, h, prefs, reflow } from "../lib/dom.ts";
import {
  compileMmlRows,
  keepEffectRows,
  rowsInRange,
  textToRows,
  withReleaseNote,
} from "../lib/mml-rows.ts";
import {
  type Block,
  clearRect,
  clipRect,
  extractBlock,
  type Point,
  pasteBlock,
  type Rect,
  rectBetween,
  transposeRect,
} from "../lib/tracker-clip.ts";
import {
  freshBlock,
  heldBlock,
  holdBlock,
  resolvePaste,
} from "../lib/tracker-clipboard.ts";
import {
  auditionSongNote,
  loadSongDoc,
  playSongDoc,
  releaseNote,
  stopEverything,
} from "../playback.ts";
import type { ViewCtx } from "../shell.ts";
import { type Doc, project } from "../state/docs.ts";
import { changeSongChip } from "../ui/change-chip.ts";
import { docActions } from "../ui/delete-doc.ts";
import { amigaFields } from "../ui/export-mod.ts";
import {
  type Group,
  group,
  rangeField,
  selectField,
  textField,
  toggleField,
} from "../ui/fields.ts";
import { fixInstrumentButton } from "../ui/fix-instruments.ts";
import { genesisFields } from "../ui/genesis-fields.ts";
import { icon } from "../ui/icons.ts";
import { showIssues } from "../ui/issues.ts";
import { createPiano, keyToOffset } from "../ui/piano.ts";
import {
  describeEffect,
  describeNote,
  EMPTY_EFFECT_HINT,
  openTrackerHelp,
} from "../ui/tracker-help.ts";
import { surface } from "../visuals/canvas.ts";
import {
  columnHeights,
  createLevelState,
  createMode,
  LEVEL_FRAMES,
  type LevelState,
  levelMode,
  type ModeState,
  updateLevel,
} from "../visuals/level.ts";
import { addVisual, type Frame } from "../visuals/loop.ts";
import {
  createTrigger,
  locate,
  scopeTraceAt,
  scopeWindowFrames,
  type Trigger,
} from "../visuals/trigger.ts";

const ALNUM_KEY = /^[0-9a-z]$/;
const TRAILING_NUMBER = /-\d+$/;
/** Extra CSS class of a tracker note cell by note value (note off and release have their own colors). */
const NOTE_CLASS: Partial<Record<string, string>> = {
  off: " off",
  release: " rel",
};
const HEX_KEY = /^[0-9a-f]$/;
const MML_COMMAND_CHAR = /[olvpqktw<>]/;
const MML_INST_TOKEN = /^@[A-Za-z0-9-]*/;
const NUM_CHAR = /[0-9.]/;
const OFFSET_IN_MESSAGE = /offset (\d+)/;
const MML_HINT_GAP_MS = 2500;
/** How long typing in a Text box rests before the grid takes the notes. */
const TEXT_COMMIT_MS = 160;

const hex = (n: number, d = 1) => n.toString(16).toUpperCase().padStart(d, "0");
/** Height of a tracker row in CSS pixels (.trow). */
const ROW_H = 20;
/** Width in CSS pixels of a column of the level display (noise and other channels with no period). */
const LEVEL_COL_PX = 2;
/** About how many frames a channel scope shows (a whole number of periods near it). */
const SCOPE_SPAN = 900;
const KEY_LO = 36;
const KEY_HI = 83;

type Field = 0 | 1 | 2 | 3 | 4 | 5 | 6;
const FLOW_FX = new Set<string>(["jump", "skip", "halt"]);
/** A row holds at most four effects. */
const MAX_FX_COLS = 4;
interface Cursor {
  ch: number;
  field: Field;
  row: number;
}

/* The song's loop is an index into the order, so an edit of the order has to carry it along to keep the loop on the
   same pattern. */

/** A step was inserted at `at`: a loop at or after it moves down one. */
function loopAfterInsert(loop: number | null, at: number): number | null {
  return loop !== null && loop >= at ? loop + 1 : loop;
}

/** The step at `at` was removed (`length` is the new order length). A loop on the removed step falls to the step that
   took its place. */
function loopAfterRemove(
  loop: number | null,
  at: number,
  length: number
): number | null {
  if (loop === null) {
    return null;
  }
  const next = loop > at ? loop - 1 : loop;
  return Math.max(0, Math.min(next, length - 1));
}

/** The step at `from` was moved to `to`: the loop follows its pattern, and the steps in between shift by one. */
function loopAfterMove(
  loop: number | null,
  from: number,
  to: number
): number | null {
  if (loop === null) {
    return null;
  }
  if (loop === from) {
    return to;
  }
  if (from < loop && loop <= to) {
    return loop - 1;
  }
  if (to <= loop && loop < from) {
    return loop + 1;
  }
  return loop;
}

function noteText(n: NoteValue | null): string {
  if (n === null) {
    return "---";
  }
  if (n === "off") {
    return "===";
  }
  if (n === "release") {
    return "^^^";
  }
  return noteName(n).padEnd(3, "-").slice(0, 3);
}

const emptyRow = (row: number): Row => ({
  fx: [],
  inst: null,
  note: null,
  row,
  vol: null,
});
const isEmpty = (r: Row) =>
  r.note === null && r.inst === null && r.vol === null && r.fx.length === 0;

/** Delete on a field: the note field empties the whole row, the others only themselves. */
function clearField(r: Row, field: number): void {
  if (field === 0) {
    r.note = null;
    r.inst = null;
    r.vol = null;
    r.fx = [];
  } else if (field === 1) {
    r.inst = null;
  } else if (field === 2) {
    r.vol = null;
  } else {
    r.fx.splice(field - 3, 1);
  }
}

const noteCell = (r: Row | undefined) => {
  const tip = describeNote(r?.note);
  return `<span class="n${NOTE_CLASS[String(r?.note)] ?? ""}" data-f="0"${tip ? ` title="${tip}"` : ""}>${noteText(r?.note ?? null)}</span>`;
};

/** The instrument's number in the inspector's list, "??" when the row names one that is gone. */
function instCell(
  r: Row | undefined,
  list: string[],
  channelKind: SongChannel["kind"]
) {
  const id = r?.inst;
  if (!id) {
    return `<span class="i e" data-f="1">--</span>`;
  }
  const at = list.indexOf(id);
  const kind = project.instruments()[id]?.kind ?? channelKind;
  return `<span class="i" data-f="1" title="${id}" style="--ik:${KIND_HEX[kind]}">${at >= 0 ? hex(at, 2) : "??"}</span>`;
}

function volCell(r: Row | undefined) {
  const v = r?.vol;
  const none = v === null || v === undefined;
  return `<span class="v${none ? " e" : ""}" data-f="2">${none ? "-" : hex(v)}</span>`;
}

function fxCell(r: Row | undefined, k: number) {
  const e = r?.fx[k];
  const text = e ? formatEffect(e).padEnd(3, "0").slice(0, 3) : "---";
  const tip = e ? describeEffect(e) : EMPTY_EFFECT_HINT;
  return `<span class="f${e ? "" : " e"}" data-f="${3 + k}" title="${tip}">${text}</span>`;
}

export function mountSong(ctx: ViewCtx, id: string): ViewHooks {
  const { host, insp } = ctx;
  const doc = (): Doc<Song> => project.get<Song>("song", id) as Doc<Song>;
  const song = () => doc().value;
  const cur: Cursor = { ch: 0, field: 0, row: 0 };
  let orderIdx = 0;
  let octave = prefs.get("tracker-octave", 3);
  let follow = prefs.get("tracker-follow", true);
  let fxCols = prefs.get<Record<string, number>>("tracker-fx", {});
  const solo = new Set<string>();
  let entry = "";
  let paused = false;
  /** The rows a block edit (or a typed cell) of this view is changing: the redraw patches just those rows. */
  let selfSpan: { from: number; to: number; wide: boolean } | null = null;
  /** The selected block: where it started, where it is now (the cursor moves with the head), and the order entry. */
  interface Selection {
    anchor: Point;
    head: Point;
    order: number;
  }
  let blockSel: Selection | null = null;
  let selEls: HTMLElement[] = [];
  /** The cell a mouse drag started on, while the button is down. */
  let dragFrom: Point | null = null;
  let playRow = -1;
  let playOrder = -1;
  const instList = () => Object.keys(project.instruments()).sort();

  host.innerHTML = `
    <div class="ed song-ed">
      <div class="song-bar">
        <button class="btn primary big" id="gPlay" title="Play or pause (Space)">${icon("play", 16)}<span>Play</span></button>
        <button class="btn" id="gHere" title="Play from the cursor (Enter)">${icon("right", 14)}<span>From cursor</span></button>
        <label class="num"><span>Tempo</span><input type="number" id="gTempo" min="20" max="400" aria-label="Tempo"></label>
        <label class="num"><span>Rows/beat</span><input type="number" id="gRpb" min="1" max="16" aria-label="Rows per beat"></label>
        <label class="num"><span>Length</span><input type="number" id="gLen" min="1" max="256" aria-label="Pattern length"></label>
        <label class="num"><span>Octave</span><span class="oct"><button class="btn icon small" id="gOctDn" aria-label="Octave down">${icon("minus", 12)}</button><b class="mono" id="gOct"></b><button class="btn icon small" id="gOctUp" aria-label="Octave up">${icon("plus", 12)}</button></span></label>
        <label class="tgl-row" title="Scroll the grid with the playhead (F, while the cursor is in the note column)"><span class="tgl"><input type="checkbox" id="gFollow"><span></span></span><small>Follow (F)</small></label>
        <button class="btn icon th-btn" id="gHelp" title="How the tracker works: columns, keys, effects" aria-label="Tracker help">?</button>
      </div>
      <div class="orderbar" id="gOrder"></div>
      <div class="tracker" id="gTracker" tabindex="0" aria-label="Tracker grid">
        <div class="tr-head" id="gHead"></div>
        <div class="tr-body" id="gBody"></div>
      </div>
      <div class="keystrip"><canvas id="gKeys" aria-label="Piano keys: press one to hear the current channel's instrument"></canvas></div>
      <div class="mml-panel" id="gText"></div>
    </div>`;
  const q = <T extends HTMLElement>(sel: string) =>
    host.querySelector(sel) as T;
  const head = q("#gHead");
  const body = q("#gBody");
  const tracker = q("#gTracker");
  const orderEl = q("#gOrder");
  const textPanel = q("#gText");
  const tempoIn = q<HTMLInputElement>("#gTempo");
  const rpbIn = q<HTMLInputElement>("#gRpb");
  const lenIn = q<HTMLInputElement>("#gLen");
  const followIn = q<HTMLInputElement>("#gFollow");
  const octEl = q("#gOct");
  const playBtn = q("#gPlay");
  const keys = createPiano(q<HTMLCanvasElement>("#gKeys"), {
    hi: KEY_HI,
    label: (n) => (n % 12 === 0 ? `C${Math.floor(n / 12) - 1}` : null),
    lo: KEY_LO,
    onDown: (n) => {
      const c = song().channels[cur.ch];
      audition(n, true);
      if (c) {
        keys.light(n, colorOf(c.id), true);
      }
      tracker.focus({ preventScroll: true });
    },
    onUp: (n) => {
      releaseNote();
      keys.release(n);
    },
  });

  /* ----- lookups ----- */
  const patternId = () =>
    song().order[clamp(orderIdx, 0, Math.max(0, song().order.length - 1))] ??
    "";
  const pattern = () => song().patterns[patternId()];
  const rowsOf = (chId: string): Map<number, Row> => {
    const mml = song().channels.find((c) => c.id === chId)?.mml;
    if (typeof mml === "string") {
      // an MML channel shows what its text plays over this pattern's rows (compiled once per change, then cached)
      return rowsInRange(
        compileMmlRows(mml, song().rowsPerBeat),
        orderStartRow(song(), clamp(orderIdx, 0, song().order.length - 1)),
        pattern()?.length ?? 0
      );
    }
    const m = new Map<number, Row>();
    for (const r of pattern()?.tracks[chId] ?? []) {
      m.set(r.row, r);
    }
    return m;
  };
  const engineIndex = (chId: string) =>
    chipChannels(song()).findIndex((c) => c.id === chId);
  /* Effect columns: what the person chose (fx button), and never fewer than the most effects a row of the channel has,
     so an effect a row carries (pan with a delay and a cut, say) is never hidden. */
  let fxNeed = new Map<string, number>();
  const fxCount = (chId: string) =>
    clamp(Math.max(fxCols[chId] ?? 1, fxNeed.get(chId) ?? 1), 1, MAX_FX_COLS);
  /** Count the effects per row of every channel; true when a channel needs a different number of columns than before. */
  function refreshFxNeed(): boolean {
    const next = new Map<string, number>();
    for (const pat of Object.values(song().patterns)) {
      for (const [ch, rows] of Object.entries(pat.tracks)) {
        for (const r of rows) {
          next.set(ch, Math.max(next.get(ch) ?? 1, r.fx.length));
        }
      }
    }
    const same =
      next.size === fxNeed.size &&
      [...next].every(([ch, n]) => fxNeed.get(ch) === n);
    fxNeed = next;
    return !same;
  }
  const fieldCount = (chId: string): number => 3 + fxCount(chId);
  const kindOf = (c: SongChannel) => c.kind;

  /* ----- grid ----- */
  let rowEls: HTMLElement[] = [];
  let scopeSurfs: {
    ch: SongChannel;
    s: ReturnType<typeof surface>;
    idx: number;
    level: LevelState;
    mode: ModeState;
    trig: Trigger;
  }[] = [];

  function cellHtml(c: SongChannel, r: Row | undefined): string {
    const fx = Array.from({ length: fxCount(c.id) }, (_, k) => fxCell(r, k));
    return (
      noteCell(r) + instCell(r, instList(), c.kind) + volCell(r) + fx.join("")
    );
  }

  function rowHtml(rowIdx: number, maps: Map<number, Row>[]): string {
    const rpb = song().rowsPerBeat;
    const cls = ["trow"];
    if (rowIdx % (rpb * 4) === 0) {
      cls.push("bar");
    } else if (rowIdx % rpb === 0) {
      cls.push("beat");
    }
    let out = `<span class="rn">${hex(rowIdx, 2)}</span>`;
    song().channels.forEach((c, ci) => {
      out += `<div class="tc fx${fxCount(c.id)}${c.mml === null ? "" : " is-mml"}${c.muted ? " muted" : ""}" data-ch="${ci}" style="--kc:${KIND_COLOR[kindOf(c)]}">${cellHtml(c, maps[ci]?.get(rowIdx))}</div>`;
    });
    return `<div class="${cls.join(" ")}" data-r="${rowIdx}">${out}</div>`;
  }

  function buildGrid(): void {
    const s = song();
    const len = pattern()?.length ?? 0;
    const maps = s.channels.map((c) => rowsOf(c.id));
    let out = "";
    for (let r = 0; r < len; r += 1) {
      out += rowHtml(r, maps);
    }
    body.innerHTML =
      out ||
      `<div class="tr-empty">This song has no patterns yet. Use the + in the order list to add one, or write the channels in MML.</div>`;
    rowEls = Array.from(body.querySelectorAll<HTMLElement>(".trow"));
    cur.row = clamp(cur.row, 0, Math.max(0, len - 1));
    cur.ch = clamp(cur.ch, 0, Math.max(0, s.channels.length - 1));
    placeCursor();
    playRow = -1;
  }

  /** Redraw the cells of one row from the document. */
  function patchCells(rowIdx: number): void {
    const el = rowEls[rowIdx];
    if (!el) {
      return;
    }
    song().channels.forEach((c, ci) => {
      const tc = el.querySelector<HTMLElement>(`.tc[data-ch="${ci}"]`);
      if (tc) {
        tc.innerHTML = cellHtml(c, rowsOf(c.id).get(rowIdx));
      }
    });
  }

  /** Redraw the rows an edit of this view changed. A wide edit (a paste) may need more effect columns than the grid has. */
  function patchSpan(span: { from: number; to: number; wide: boolean }): void {
    if (span.wide && refreshFxNeed()) {
      buildHead();
      buildGrid();
      syncTexts();
      return;
    }
    for (let r = span.from; r <= span.to; r += 1) {
      patchCells(r);
    }
    placeCursor();
    syncTexts();
  }

  function buildHead(): void {
    head.replaceChildren();
    for (const e of scopeSurfs) {
      e.s.dispose();
    }
    scopeSurfs = [];
    const s = song();
    head.append(h("span", { class: "rn hc" }, "ROW"));
    s.channels.forEach((c, ci) => {
      const idx = engineIndex(c.id);
      const cell = h("div", {
        class: `tc tch fx${fxCount(c.id)}${c.muted ? " muted" : ""}${ci === cur.ch ? " sel" : ""}`,
        "data-ch": ci,
        style: `--kc:${KIND_COLOR[kindOf(c)]}`,
      });
      cell.innerHTML = `
        <div class="tch-top"><span class="kname"></span>
          <button class="tb m${c.muted ? " on" : ""}" data-act="mute" title="Mute (click). Solo: Alt+click" aria-label="Mute ${c.id}">${c.muted ? "M" : "M"}</button>
          <button class="tb s${solo.has(c.id) ? " on" : ""}" data-act="solo" title="Solo" aria-label="Solo ${c.id}">S</button>
          <button class="tb${showsText(c) ? " on" : ""}" data-act="text" title="Show this channel as text (MML)" aria-label="Text view of ${c.id}">TXT</button>
          <button class="tb" data-act="fx" title="Show another effect column" aria-label="Effect columns for ${c.id}">fx${fxCount(c.id)}</button>
        </div>
        <canvas class="scope" aria-label="${c.id} scope"></canvas>
        <div class="tch-sub"><span class="mono lab"></span></div>`;
      (cell.querySelector(".kname") as HTMLElement).textContent =
        c.id.toUpperCase();
      (cell.querySelector(".lab") as HTMLElement).textContent =
        `${KIND_LABEL[kindOf(c)]} ${c.instrument ?? ""}`.trim();
      head.append(cell);
      const cv = cell.querySelector("canvas") as HTMLCanvasElement;
      const surf = surface(cv);
      scopeSurfs.push({
        ch: c,
        idx,
        level: createLevelState(Math.ceil(surf.w / LEVEL_COL_PX)),
        mode: createMode(),
        s: surf,
        trig: createTrigger(),
      });
    });
  }

  function placeCursor(): void {
    for (const el of body.querySelectorAll(".cur")) {
      el.classList.remove("cur");
    }
    for (const el of head.querySelectorAll(".tch.sel")) {
      el.classList.remove("sel");
    }
    head.querySelector(`.tch[data-ch="${cur.ch}"]`)?.classList.add("sel");
    paintSelection();
    const rowEl = rowEls[cur.row];
    const tc = rowEl?.querySelector<HTMLElement>(`.tc[data-ch="${cur.ch}"]`);
    const c = song().channels[cur.ch];
    if (!(c && tc)) {
      return;
    }
    const f = Math.min(cur.field, fieldCount(c.id) - 1);
    const span =
      tc.querySelector<HTMLElement>(`[data-f="${f}"]`) ?? tc.firstElementChild;
    span?.classList.add("cur");
    rowEl?.classList.add("cur");
    rowEls.forEach((el, i) => {
      if (i !== cur.row) {
        el.classList.remove("cur");
      }
    });
  }

  /* The sticky header covers the top of the scroll box, so rows are scrolled in whole row steps: scrollTop is always
     a multiple of the row height and a row is either fully below the header or fully scrolled away, never half hidden. */
  const snapRow = (n: number) => Math.max(0, Math.round(n)) * ROW_H;
  function scrollToCursor(): void {
    if (!rowEls[cur.row]) {
      return;
    }
    scrollToChannel(cur.ch);
    const top = cur.row * ROW_H;
    const bottom = head.offsetHeight + (cur.row + 1) * ROW_H;
    if (tracker.scrollTop > top) {
      tracker.scrollTop = top;
    } else if (bottom - tracker.scrollTop > tracker.clientHeight) {
      tracker.scrollTop =
        Math.ceil((bottom - tracker.clientHeight) / ROW_H) * ROW_H;
    }
  }

  /** Bring a channel's column into view sideways, clear of the sticky row numbers on the left. */
  function scrollToChannel(ch: number): void {
    const col = head.querySelector<HTMLElement>(`.tch[data-ch="${ch}"]`);
    if (!col) {
      return;
    }
    const rowNumbers = head.querySelector<HTMLElement>(".rn")?.offsetWidth ?? 0;
    const left = col.offsetLeft - rowNumbers;
    const right = col.offsetLeft + col.offsetWidth;
    if (tracker.scrollLeft > left) {
      tracker.scrollLeft = left;
    } else if (right - tracker.scrollLeft > tracker.clientWidth) {
      tracker.scrollLeft = right - tracker.clientWidth;
    }
  }
  // over the channel headers a plain mouse wheel scrolls sideways (most mice cannot scroll horizontally)
  head.addEventListener(
    "wheel",
    (e) => {
      const wide = tracker.scrollWidth > tracker.clientWidth;
      if (!wide || e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        return;
      }
      e.preventDefault();
      tracker.scrollLeft += e.deltaY;
    },
    { passive: false }
  );

  /* ----- order list ----- */
  function buildOrder(): void {
    const s = song();
    orderEl.replaceChildren();
    orderEl.append(h("span", { class: "pxh olab" }, "Order"));
    // the entries wrap inside their own box and scroll when there are many, so a long order never pushes the
    // buttons or the grid out of the panel
    const list = h("div", {
      "aria-label": "Order list",
      class: "olist",
      role: "list",
    });
    const ctl = h("div", { class: "octl" });
    orderEl.append(list, ctl);
    s.order.forEach((pid, i) => {
      const chip = h("button", {
        class: `ochip${i === orderIdx ? " cur" : ""}${s.loop === i ? " loop" : ""}${i === playOrder ? " playing" : ""}`,
        "data-i": i,
        draggable: "true",
        role: "listitem",
        title: `${pid}. Click to edit, drag to reorder${s.loop === i ? ". The song loops back here" : ""}`,
      });
      chip.innerHTML = `<small class="mono">${hex(i, 2)}</small><span></span>${s.loop === i ? icon("refresh", 10, "lp") : ""}`;
      (chip.querySelector("span") as HTMLElement).textContent = pid;
      chip.addEventListener("click", () => setOrder(i));
      chip.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("text/plain", String(i));
      });
      chip.addEventListener("dragover", (e) => e.preventDefault());
      chip.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer?.getData("text/plain"));
        if (Number.isInteger(from) && from !== i) {
          moveOrder(from, i);
        }
      });
      list.append(chip);
    });
    const btn = (label: string, ic: string, title: string, fn: () => void) => {
      const b = h("button", {
        "aria-label": title,
        class: "btn small",
        onclick: fn,
        title,
      });
      b.innerHTML = `${icon(ic, 12)}<span>${label}</span>`;
      ctl.append(b);
    };
    btn("New", "plus", "Add an empty pattern after this one", addPattern);
    btn("Copy", "copy", "Duplicate this pattern after this one", dupPattern);
    btn("Loop", "refresh", "Loop the song back to this pattern", () => {
      project.edit<Song>(doc(), (d) => {
        d.loop = d.loop === orderIdx ? null : orderIdx;
      });
    });
    btn(
      "Left",
      "left",
      "Move this pattern earlier",
      () => orderIdx > 0 && moveOrder(orderIdx, orderIdx - 1)
    );
    btn(
      "Right",
      "right",
      "Move this pattern later",
      () => orderIdx < s.order.length - 1 && moveOrder(orderIdx, orderIdx + 1)
    );
    btn("Remove", "trash", "Remove this pattern from the order", () => {
      if (s.order.length <= 1) {
        app.toast("A song needs at least one pattern");
        return;
      }
      project.edit<Song>(doc(), (d) => {
        d.order.splice(orderIdx, 1);
        d.loop = loopAfterRemove(d.loop, orderIdx, d.order.length);
      });
      orderIdx = Math.min(orderIdx, song().order.length - 1);
      rebuildAll();
    });
    const sel = h("select", {
      "aria-label": "Pattern used here",
      class: "pat-sel",
      title: "Which pattern this step of the order plays",
    }) as HTMLSelectElement;
    for (const pid of Object.keys(s.patterns)) {
      sel.append(h("option", { value: pid }, pid));
    }
    sel.value = patternId();
    sel.addEventListener("change", () => {
      project.edit<Song>(doc(), (d) => {
        d.order[orderIdx] = sel.value;
      });
      rebuildAll();
    });
    ctl.append(sel);
    keepOrderInView();
  }

  /** Scrolls the order list, inside its own box and in whole rows, to show the entry that plays (else the one being edited). */
  function keepOrderInView(): void {
    const list = orderEl.querySelector<HTMLElement>(".olist");
    const chip =
      list?.querySelector<HTMLElement>(".ochip.playing") ??
      list?.querySelector<HTMLElement>(".ochip.cur");
    const first = list?.firstElementChild as HTMLElement | null | undefined;
    if (!(list && chip && first)) {
      return;
    }
    const gap = Number.parseFloat(getComputedStyle(list).rowGap) || 0;
    const rowH = chip.offsetHeight + gap;
    const origin = first.offsetTop;
    const row = Math.round((chip.offsetTop - origin) / rowH);
    const shown = Math.max(1, Math.floor((list.clientHeight - origin) / rowH));
    const firstShown = Math.round(list.scrollTop / rowH);
    if (row < firstShown) {
      list.scrollTop = row * rowH;
    } else if (row >= firstShown + shown) {
      list.scrollTop = (row - shown + 1) * rowH;
    }
  }

  function setOrder(i: number): void {
    flushTexts();
    orderIdx = clamp(i, 0, Math.max(0, song().order.length - 1));
    cur.row = 0;
    buildOrder();
    buildGrid();
    syncTexts();
    syncBar();
    tracker.scrollTop = 0;
  }
  function moveOrder(from: number, to: number): void {
    project.edit<Song>(doc(), (d) => {
      const [x] = d.order.splice(from, 1);
      if (x !== undefined) {
        d.order.splice(to, 0, x);
      }
      d.loop = loopAfterMove(d.loop, from, to);
    });
    orderIdx = to;
    rebuildAll();
  }
  function newPatternId(base: string): string {
    const s = song();
    let n = Object.keys(s.patterns).length + 1;
    let pid = base;
    while (s.patterns[pid]) {
      n += 1;
      pid = `${base.replace(TRAILING_NUMBER, "")}-${n}`;
    }
    return pid;
  }
  function addPattern(): void {
    const pid = newPatternId("pattern");
    const len = pattern()?.length ?? 32;
    project.edit<Song>(doc(), (d) => {
      d.patterns[pid] = { length: len, tracks: {} };
      d.order.splice(orderIdx + 1, 0, pid);
      d.loop = loopAfterInsert(d.loop, orderIdx + 1);
    });
    orderIdx += 1;
    rebuildAll();
  }
  function dupPattern(): void {
    const src = pattern();
    if (!src) {
      return;
    }
    const pid = newPatternId(patternId());
    project.edit<Song>(doc(), (d) => {
      d.patterns[pid] = JSON.parse(JSON.stringify(src));
      d.order.splice(orderIdx + 1, 0, pid);
      d.loop = loopAfterInsert(d.loop, orderIdx + 1);
    });
    orderIdx += 1;
    rebuildAll();
  }

  /* ----- editing rows ----- */
  function editRow(chIdx: number, rowIdx: number, fn: (r: Row) => void): void {
    const c = song().channels[chIdx];
    const pid = patternId();
    if (!(c && pid) || c.mml !== null) {
      return;
    }
    selfSpan = { from: rowIdx, to: rowIdx, wide: false };
    project.edit<Song>(doc(), (d) => {
      const p = d.patterns[pid];
      if (!p) {
        return;
      }
      const list = p.tracks[c.id] ?? [];
      p.tracks[c.id] = list;
      let r = list.find((x) => x.row === rowIdx);
      if (!r) {
        r = emptyRow(rowIdx);
        list.push(r);
        list.sort((a, b) => a.row - b.row);
      }
      fn(r);
      if (isEmpty(r)) {
        list.splice(list.indexOf(r), 1);
      }
      if (list.length === 0) {
        delete p.tracks[c.id];
      }
    });
    selfSpan = null;
  }

  function currentRow(): Row | undefined {
    const c = song().channels[cur.ch];
    return c ? rowsOf(c.id).get(cur.row) : undefined;
  }

  function instrumentFor(chIdx: number, r?: Row): Doc | undefined {
    const c = song().channels[chIdx];
    if (!c) {
      return undefined;
    }
    // the nearest earlier row that names an instrument, else the channel's, else the first of its kind
    const map = rowsOf(c.id);
    let inst: string | null = r?.inst ?? null;
    for (let i = cur.row; inst === null && i >= 0; i -= 1) {
      inst = map.get(i)?.inst ?? null;
    }
    inst ??= c.instrument;
    const found = inst ? project.get("instrument", inst) : undefined;
    return (
      found ??
      project
        .list("instrument")
        .find((d) => (d.value as Instrument).kind === c.kind)
    );
  }

  /** Play a note on the cursor's channel, through its own instrument; `hold` keeps it until the key is let go. */
  function audition(note: number, hold = false): void {
    const c = song().channels[cur.ch];
    const d = instrumentFor(cur.ch, currentRow());
    if (c && d) {
      auditionSongNote(
        doc(),
        { id: c.id, index: engineIndex(c.id) },
        d,
        note,
        hold ? undefined : 0.35
      );
    }
  }

  function move(dRow: number, dCh = 0, dField = 0): void {
    const s = song();
    const len = pattern()?.length ?? 1;
    entry = "";
    blockSel = null;
    cur.row = clamp(cur.row + dRow, 0, len - 1);
    if (dCh) {
      cur.ch = (cur.ch + dCh + s.channels.length) % s.channels.length;
    }
    if (dField) {
      let f = cur.field + dField;
      let { ch } = cur;
      const n = s.channels.length;
      if (f < 0) {
        ch = (ch - 1 + n) % n;
        f = fieldCount(s.channels[ch]?.id ?? "") - 1;
      } else if (f >= fieldCount(s.channels[ch]?.id ?? "")) {
        ch = (ch + 1) % n;
        f = 0;
      }
      cur.ch = ch;
      cur.field = f as Field;
    }
    const c = s.channels[cur.ch];
    if (c) {
      cur.field = Math.min(cur.field, fieldCount(c.id) - 1) as Field;
    }
    placeCursor();
    scrollToCursor();
  }

  function advance(): void {
    move(1);
  }

  /* ----- block selection, copy and paste ----- */
  /* The pure parts (cut a block out of a pattern, put one in, clear, transpose, the text form) are in lib/tracker-clip.ts
     and the clipboard in lib/tracker-clipboard.ts; this is the keys and the mouse, one undo step per operation. */
  const cursorPoint = (): Point => ({ ch: cur.ch, row: cur.row });
  const channelIds = () => song().channels.map((c) => c.id);
  /** The channels kept as text: their cells are read only. */
  const textChannels = () =>
    new Set(
      song()
        .channels.filter((c) => c.mml !== null)
        .map((c) => c.id)
    );

  /** The selection as a rectangle inside the open pattern, or null when there is none (or it was for another pattern). */
  function selRect(): Rect | null {
    if (blockSel && blockSel.order !== orderIdx) {
      blockSel = null;
    }
    return blockSel
      ? clipRect(
          rectBetween(blockSel.anchor, blockSel.head),
          pattern()?.length ?? 0,
          song().channels.length
        )
      : null;
  }

  /** What copy, cut, clear and transpose act on: the selection, else the cell under the cursor. */
  function blockRect(): Rect | null {
    return (
      selRect() ??
      clipRect(
        rectBetween(cursorPoint(), cursorPoint()),
        pattern()?.length ?? 0,
        song().channels.length
      )
    );
  }

  /** Show the selection: every selected cell gets the `blk` class (the grid rebuilds its cells, so this runs on each
      cursor placement). */
  function paintSelection(): void {
    for (const el of selEls) {
      el.classList.remove("blk");
    }
    selEls = [];
    const r = selRect();
    if (!r) {
      return;
    }
    for (let row = r.row0; row <= r.row1; row += 1) {
      for (let ch = r.ch0; ch <= r.ch1; ch += 1) {
        const tc = rowEls[row]?.querySelector<HTMLElement>(
          `.tc[data-ch="${ch}"]`
        );
        if (tc) {
          tc.classList.add("blk");
          selEls.push(tc);
        }
      }
    }
  }

  function setSelection(anchor: Point, end: Point): void {
    blockSel = { anchor, head: end, order: orderIdx };
    paintSelection();
  }

  function clearSelection(): void {
    if (blockSel) {
      blockSel = null;
      paintSelection();
    }
  }

  /** Shift with a cursor key: grow or shrink the selection from its head, and the cursor goes there. */
  function extendSelection(k: string): boolean {
    const len = pattern()?.length ?? 1;
    const from = blockSel?.head ?? cursorPoint();
    const to: Record<string, Point> = {
      ArrowDown: { ch: from.ch, row: from.row + 1 },
      ArrowLeft: { ch: from.ch - 1, row: from.row },
      ArrowRight: { ch: from.ch + 1, row: from.row },
      ArrowUp: { ch: from.ch, row: from.row - 1 },
      End: { ch: from.ch, row: len - 1 },
      Home: { ch: from.ch, row: 0 },
      PageDown: { ch: from.ch, row: from.row + 16 },
      PageUp: { ch: from.ch, row: from.row - 16 },
    };
    const target = to[k];
    if (!target) {
      return false;
    }
    const anchor = blockSel?.anchor ?? cursorPoint();
    const end = {
      ch: clamp(target.ch, 0, song().channels.length - 1),
      row: clamp(target.row, 0, len - 1),
    };
    move(end.row - cur.row, end.ch - cur.ch);
    setSelection(anchor, end);
    return true;
  }

  /** Ctrl A: the cursor's channel in this pattern; again (or with the channel already selected), every channel. */
  function selectAll(): void {
    const len = pattern()?.length ?? 0;
    const last = song().channels.length - 1;
    if (len === 0 || last < 0) {
      return;
    }
    const r = selRect();
    const full = r?.row0 === 0 && r.row1 === len - 1;
    const channelDone = full && r.ch0 === cur.ch && r.ch1 === cur.ch;
    const allDone = full && r.ch0 === 0 && r.ch1 === last;
    if (channelDone || allDone) {
      setSelection({ ch: 0, row: 0 }, { ch: last, row: len - 1 });
    } else {
      setSelection({ ch: cur.ch, row: 0 }, { ch: cur.ch, row: len - 1 });
    }
  }

  /** Change the open pattern in one undo step. `span` is the rows the edit touches (the redraw patches just those). */
  function editBlock(
    span: { from: number; to: number },
    wide: boolean,
    fn: (p: Pattern) => void
  ): void {
    const pid = patternId();
    if (!pid) {
      return;
    }
    selfSpan = { ...span, wide };
    project.edit<Song>(doc(), (d) => {
      const p = d.patterns[pid];
      if (p) {
        fn(p);
      }
    });
    selfSpan = null;
  }

  /** Say, once in a while, that the channels of `rect` kept as text were left alone. */
  function warnTextChannels(rect: Rect): void {
    const kept = song()
      .channels.slice(rect.ch0, rect.ch1 + 1)
      .find((c) => c.mml !== null);
    if (kept) {
      readOnlyHint(kept);
    }
  }

  function copyBlock(): Rect | null {
    const rect = blockRect();
    if (!rect) {
      return null;
    }
    const maps = song().channels.map((c, i) =>
      i >= rect.ch0 && i <= rect.ch1 ? rowsOf(c.id) : undefined
    );
    holdBlock(extractBlock(maps, rect), instList());
    return rect;
  }

  /** Run `fn` over the selection (else the cursor's cell) in one undo step. */
  function editSelected(
    fn: (
      p: Pattern,
      rect: Rect,
      ids: string[],
      locked: ReadonlySet<string>
    ) => void
  ): void {
    const rect = blockRect();
    if (!rect) {
      return;
    }
    const ids = channelIds();
    const locked = textChannels();
    editBlock({ from: rect.row0, to: rect.row1 }, false, (p) =>
      fn(p, rect, ids, locked)
    );
    warnTextChannels(rect);
  }

  const clearBlock = () =>
    editSelected((p, rect, ids, locked) => clearRect(p, ids, rect, locked));

  function cutBlock(): void {
    if (copyBlock()) {
      clearBlock();
    }
  }

  /** Put `block` down with its top left at the selection's (else the cursor's), and select what it covered. */
  function pasteHeld(block: Block): void {
    const len = pattern()?.length ?? 0;
    const picked = selRect();
    const at = picked ? { ch: picked.ch0, row: picked.row0 } : cursorPoint();
    const ids = channelIds();
    const locked = textChannels();
    const done: { rect: Rect | null } = { rect: null };
    editBlock(
      { from: at.row, to: Math.min(len, at.row + block.rows) - 1 },
      true,
      (p) => {
        done.rect = pasteBlock(p, ids, block, at, locked);
      }
    );
    if (done.rect) {
      setSelection(
        { ch: done.rect.ch0, row: done.rect.row0 },
        { ch: done.rect.ch1, row: done.rect.row1 }
      );
      warnTextChannels(done.rect);
    }
  }

  const transposeBlock = (semitones: number) =>
    editSelected((p, rect, ids, locked) => {
      transposeRect(p, ids, rect, semitones, locked);
    });

  /** The paste event: the browser hands over the system clipboard's text (never a permission prompt). */
  tracker.addEventListener("paste", (e) => {
    const block = resolvePaste(
      e.clipboardData?.getData("text/plain"),
      instList()
    );
    if (block) {
      e.preventDefault();
      pasteHeld(block);
    }
  });

  /** Ctrl or Cmd with a key: select all, copy, cut, paste, transpose. True when it was one of them (Ctrl V is left to
      the paste event unless the block copied here is still the newest thing copied). */
  function blockKey(e: KeyboardEvent): boolean {
    if (e.altKey || !pattern()) {
      return false;
    }
    const k = e.key.toLowerCase();
    if (k === "arrowup" || k === "arrowdown") {
      transposeBlock((k === "arrowup" ? 1 : -1) * (e.shiftKey ? 12 : 1));
      return true;
    }
    const plain: Record<string, () => void> = {
      a: selectAll,
      c: () => {
        copyBlock();
      },
      x: cutBlock,
    };
    const run = plain[k];
    if (run && !e.shiftKey) {
      run();
      return true;
    }
    const fresh = k === "v" && !e.shiftKey ? freshBlock() : null;
    if (fresh) {
      pasteHeld(fresh);
    }
    return fresh !== null;
  }

  /** Cursor movement and Enter (play from here). */
  function navigationKey(e: KeyboardEvent): boolean {
    const steps = new Map<string, () => void>([
      ["ArrowUp", () => move(-1)],
      ["ArrowDown", () => move(1)],
      ["ArrowLeft", () => move(0, 0, -1)],
      ["ArrowRight", () => move(0, 0, 1)],
      ["Tab", () => move(0, e.shiftKey ? -1 : 1)],
      ["PageUp", () => move(-16)],
      ["PageDown", () => move(16)],
      ["Home", () => move(-cur.row)],
      ["End", () => move(1e6)],
      ["Enter", () => playFrom(orderIdx, cur.row)],
    ]);
    const step = steps.get(e.key);
    step?.();
    return step !== undefined;
  }

  /** A key that would edit the cell of a channel kept as text: nothing changes, a short hint says where its notes are. */
  let hintAt = 0;
  function readOnlyHint(c: SongChannel): void {
    const now = Date.now();
    if (now - hintAt > MML_HINT_GAP_MS) {
      hintAt = now;
      app.toast(
        `${c.id.toUpperCase()} stays as text (the patterns jump, skip or halt, so its notes cannot be rows), so its cells are read only. Edit its text below the grid.`
      );
    }
  }
  function mmlCellKey(c: SongChannel, k: string): boolean {
    const edits =
      k === "Delete" ||
      k === "Backspace" ||
      (k.length === 1 && ALNUM_KEY.test(k.toLowerCase())) ||
      k === "`";
    if (edits) {
      readOnlyHint(c);
    }
    return edits;
  }

  /** Delete clears the field under the cursor and moves down; Backspace clears it and stays. */
  function clearKey(c: SongChannel, key: string): void {
    if (c.mml !== null) {
      return;
    }
    const f = cur.field;
    editRow(cur.ch, cur.row, (r) => clearField(r, f));
    entry = "";
    if (key === "Delete") {
      advance();
    }
  }

  /** The keys that mean the same in every field: octave down and up. F follows the playhead, but only where F is not a
   hex digit: in the note column (or an MML channel), never in the instrument, volume or effect columns. */
  function globalKey(k: string, hexColumn: boolean): boolean {
    if (k === "-" || k === "_") {
      setOctave(octave - 1);
    } else if (k === "=" || k === "+") {
      setOctave(octave + 1);
    } else if ((k === "f" || k === "F") && !hexColumn) {
      setFollow(!follow);
    } else {
      return false;
    }
    return true;
  }

  /** Note field: the piano keys, 1 for note off and ` for release. */
  function noteKey(c: SongChannel, k: string): boolean {
    const special = { "`": "release", "1": "off" } as const;
    if (k === "1" || k === "`") {
      editRow(cur.ch, cur.row, (r) => {
        r.note = special[k];
      });
      advance();
      return true;
    }
    const off = keyToOffset(k);
    if (off === null || k.length !== 1) {
      return false;
    }
    const note = clamp((octave + 1) * 12 + off, 0, 127);
    const prev = currentRow();
    const il = instList();
    editRow(cur.ch, cur.row, (r) => {
      r.note = note;
      // new notes on the first row pick up the channel's instrument so the grid shows what will play
      const first =
        c.instrument && il.includes(c.instrument) ? c.instrument : null;
      if (r.inst === null && !prev?.inst && first && cur.row === 0) {
        r.inst = first;
      }
    });
    audition(note);
    advance();
    return true;
  }

  /** Instrument field: two hex digits pick the instrument by its number in the inspector. */
  function instKey(kl: string): boolean {
    if (!HEX_KEY.test(kl)) {
      return false;
    }
    entry += kl;
    if (entry.length < 2) {
      flashEntry();
      return true;
    }
    const idx = Number.parseInt(entry, 16);
    entry = "";
    const instId = instList()[idx];
    if (!instId) {
      app.toast(
        `There is no instrument ${hex(idx, 2)}. They are numbered in the inspector.`
      );
      return true;
    }
    editRow(cur.ch, cur.row, (r) => {
      r.inst = instId;
    });
    advance();
    return true;
  }

  /** Volume field: one hex digit. */
  function volKey(kl: string): boolean {
    if (!HEX_KEY.test(kl)) {
      return false;
    }
    const v = Number.parseInt(kl, 16);
    editRow(cur.ch, cur.row, (r) => {
      r.vol = v;
    });
    advance();
    return true;
  }

  /** Effect fields: a letter or digit, then two hex digits. */
  function effectKey(kl: string): boolean {
    if (!ALNUM_KEY.test(kl)) {
      return false;
    }
    entry += kl;
    if (entry.length < 3) {
      flashEntry();
      return true;
    }
    const code = entry;
    const eff: Effect | null = parseEffect(code.toUpperCase());
    const slot = cur.field - 3;
    entry = "";
    if (!eff) {
      app.toast(
        `${code.toUpperCase()} is not an effect. Try 047 (arpeggio) or A0F (volume slide): a letter or digit, then two hex digits.`
      );
      return true;
    }
    editRow(cur.ch, cur.row, (r) => {
      r.fx[slot] = eff;
      r.fx = r.fx.filter(Boolean);
    });
    advance();
    return true;
  }

  function onTrackerKey(e: KeyboardEvent): boolean {
    const c = song().channels[cur.ch];
    if (!(c && pattern())) {
      return false;
    }
    const k = e.key;
    if (k === "Escape" && selRect()) {
      clearSelection();
      return true;
    }
    if (e.shiftKey && extendSelection(k)) {
      return true;
    }
    if (navigationKey(e)) {
      return true;
    }
    if (k === "Delete" || k === "Backspace") {
      if (selRect()) {
        clearBlock();
        return true;
      }
      if (c.mml !== null) {
        return mmlCellKey(c, k);
      }
      clearKey(c, k);
      return true;
    }
    if (e.shiftKey && k.length > 1) {
      return false;
    }
    if (globalKey(k, c.mml === null && cur.field > 0)) {
      return true;
    }
    if (c.mml !== null) {
      // the cells show the MML, they cannot be typed into: say where to edit instead of ignoring the key
      return mmlCellKey(c, k);
    }
    const kl = k.toLowerCase();
    switch (cur.field) {
      case 0:
        return noteKey(c, k);
      case 1:
        return instKey(kl);
      case 2:
        return volKey(kl);
      default:
        return effectKey(kl);
    }
  }

  function flashEntry(): void {
    const span = body.querySelector<HTMLElement>(".cur");
    if (span) {
      span.dataset.typing = entry.toUpperCase();
    }
  }

  /* ----- grid mouse ----- */
  /** The cell under a pointer event, or null. */
  function cellOf(e: Event): (Point & { field: Field | null }) | null {
    const target = e.target as HTMLElement;
    const tc = target.closest<HTMLElement>(".tc");
    const rowEl = target.closest<HTMLElement>(".trow");
    if (!(tc && rowEl)) {
      return null;
    }
    const span = target.closest<HTMLElement>("[data-f]");
    return {
      ch: Number(tc.dataset.ch),
      field: span ? (Number(span.dataset.f) as Field) : null,
      row: Number(rowEl.dataset.r),
    };
  }
  body.addEventListener("pointerdown", (e) => {
    const cell = cellOf(e);
    if (!cell) {
      return;
    }
    const primary = e.button === 0;
    const before = cursorPoint();
    entry = "";
    cur.row = cell.row;
    cur.ch = cell.ch;
    cur.field = cell.field ?? 0;
    if (primary && e.shiftKey) {
      // Shift click: the block from where the selection (or the cursor) was to this cell
      const anchor = blockSel?.anchor ?? before;
      dragFrom = anchor;
      blockSel = {
        anchor,
        head: { ch: cell.ch, row: cell.row },
        order: orderIdx,
      };
    } else {
      dragFrom = primary ? { ch: cell.ch, row: cell.row } : null;
      blockSel = null;
    }
    placeCursor();
    tracker.focus({ preventScroll: true });
  });
  // dragging across cells selects them: the head follows the pointer, the cursor with it
  body.addEventListener("pointermove", (e) => {
    if (!dragFrom) {
      return;
    }
    if (e.buttons % 2 === 0) {
      dragFrom = null;
      return;
    }
    const cell = cellOf(e);
    if (!cell || (cell.row === cur.row && cell.ch === cur.ch)) {
      return;
    }
    entry = "";
    cur.row = cell.row;
    cur.ch = cell.ch;
    blockSel = {
      anchor: dragFrom,
      head: { ch: cell.ch, row: cell.row },
      order: orderIdx,
    };
    placeCursor();
  });
  const endDrag = () => {
    dragFrom = null;
  };
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
  ctx.cleanup(() => {
    document.removeEventListener("pointerup", endDrag);
    document.removeEventListener("pointercancel", endDrag);
  });
  tracker.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && blockKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    if (e.key === " ") {
      return;
    }
    if (onTrackerKey(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  head.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    const tc = (e.target as HTMLElement).closest<HTMLElement>(".tch");
    if (!tc) {
      return;
    }
    const ci = Number(tc.dataset.ch);
    const c = song().channels[ci];
    if (!c) {
      return;
    }
    cur.ch = ci;
    const act = btn?.dataset.act;
    if (act === "mute") {
      if ((e as MouseEvent).altKey) {
        toggleSolo(c.id, ci);
      } else {
        project.edit<Song>(doc(), (d) => {
          const ch = d.channels[ci];
          if (ch) {
            ch.muted = !ch.muted;
          }
        });
      }
    } else if (act === "solo") {
      toggleSolo(c.id, ci);
    } else if (act === "text") {
      toggleText(c);
    } else if (act === "fx") {
      fxCols = {
        ...fxCols,
        [c.id]: fxCount(c.id) >= MAX_FX_COLS ? 1 : fxCount(c.id) + 1,
      };
      prefs.set("tracker-fx", fxCols);
      rebuildAll();
    } else {
      placeCursor();
      buildInspector();
    }
  });
  function toggleSolo(chId: string, ci: number): void {
    if (solo.has(chId)) {
      solo.delete(chId);
    } else {
      solo.add(chId);
    }
    const idx = engineIndex(chId);
    if (idx >= 0) {
      engine.setChannel(idx, { solo: solo.has(chId) });
    }
    for (const b of head.querySelectorAll<HTMLElement>(
      `.tch[data-ch="${ci}"] .tb.s`
    )) {
      b.classList.toggle("on", solo.has(chId));
    }
    syncSolo();
  }
  function syncSolo(): void {
    const any = solo.size > 0;
    for (const el of head.querySelectorAll<HTMLElement>(".tch")) {
      const c = song().channels[Number(el.dataset.ch)];
      el.classList.toggle("dimmed", any && !!c && !solo.has(c.id));
    }
  }

  /* ----- MML ----- */
  function mmlHighlight(src: string, errs: number[]): string {
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let out = "";
    let i = 0;
    while (i < src.length) {
      const ch = src[i] ?? "";
      const bad = errs.includes(i);
      let cls = "";
      let len = 1;
      if (ch === ";") {
        len =
          src.indexOf("\n", i) < 0 ? src.length - i : src.indexOf("\n", i) - i;
        cls = "c";
      } else if (ch === "@") {
        const m = MML_INST_TOKEN.exec(src.slice(i));
        len = m ? m[0].length : 1;
        cls = "i";
      } else if (ch === "[" || ch === "]" || ch === "L" || ch === "|") {
        cls = "k";
      } else if (NUM_CHAR.test(ch)) {
        cls = "d";
      } else if (MML_COMMAND_CHAR.test(ch)) {
        cls = "o";
      }
      const piece = esc(src.slice(i, i + len));
      out += choose(
        [
          [bad, `<u class="bad">${piece}</u>`],
          [!!cls, `<i class="${cls}">${piece}</i>`],
        ],
        piece
      );
      i += len;
    }
    return `${out}\n`;
  }

  /* ----- Text view ----- */
  /* The grid is the one editor. A channel's text is a view of its rows in the pattern that is selected in the order list:
     the grid changes the text, typing in the text changes the grid. A channel kept as MML (the patterns jump, skip or halt) shows
     its whole text instead, always open, and the text is what you edit. */
  interface TextBox {
    ch: string;
    commit: ReturnType<typeof debounce>;
    kept: boolean;
    label: HTMLElement;
    msg: HTMLElement;
    note: HTMLElement | null;
    pid: string;
    pre: HTMLElement;
    /** The song row the box's pattern starts at (the order entry it was opened on). */
    start: number;
    ta: HTMLTextAreaElement;
  }
  const textKey = `tracker-text:${id}`;
  const textOpen = new Set(prefs.get<string[]>(textKey, []));
  const textBoxes = new Map<string, TextBox>();
  let selfMml = false;

  /** Why the converter left MML channels as text: the patterns jump, skip or halt, or the song is very long. */
  function keptReason(): string {
    const flow = Object.values(song().patterns).some((p) =>
      Object.values(p.tracks).some((rows) =>
        rows.some((r) => r.fx.some((e) => FLOW_FX.has(e.type)))
      )
    );
    return flow
      ? "the patterns jump, skip or halt, so rows would not play in time order"
      : "the song is longer than 256 bars";
  }
  function isKept(c: SongChannel): boolean {
    return c.mml !== null;
  }
  function showsText(c: SongChannel): boolean {
    return isKept(c) || textOpen.has(c.id);
  }
  /** The song row where the order entry `at` starts: where its text begins in time. */
  const startRowOf = (at: number): number => orderStartRow(song(), at);
  /** The channel's rows in the selected pattern as text, with the release marks in a trailing comment. */
  function patternText(c: SongChannel): string {
    const rows = pattern()?.tracks[c.id] ?? [];
    return withReleaseNote(
      patternToMml(rows, song().rowsPerBeat, pattern()?.length, {
        ...songTiming(song()),
        startRow: startRowOf(orderIdx),
      }),
      rows
    );
  }
  const textOf = (c: SongChannel): string =>
    isKept(c) ? (c.mml ?? "") : patternText(c);
  const labelOf = (c: SongChannel): string =>
    isKept(c) ? `${c.id} MML` : `${c.id} in pattern ${patternId()}`;

  function toggleText(c: SongChannel): void {
    if (isKept(c)) {
      app.toast(`${c.id} stays as text, so its text is always shown.`);
      return;
    }
    if (textOpen.has(c.id)) {
      textOpen.delete(c.id);
    } else {
      textOpen.add(c.id);
    }
    prefs.set(textKey, [...textOpen]);
    for (const b of head.querySelectorAll<HTMLElement>(
      `.tch[data-ch="${song().channels.indexOf(c)}"] [data-act="text"]`
    )) {
      b.classList.toggle("on", textOpen.has(c.id));
    }
    syncTexts();
  }

  /** The highlighted text, the one line message under the title, and the underline of parse errors. */
  function checkText(box: TextBox): void {
    const c = song().channels.find((x) => x.id === box.ch);
    const text = box.ta.value;
    let errorAt: number[];
    let message: string | null;
    let state: "ok" | "bad" | "warn" = "ok";
    if (c && isKept(c)) {
      const res = parseMml(text);
      errorAt = res.issues.flatMap((i) => {
        const m = OFFSET_IN_MESSAGE.exec(i.message);
        return i.severity === "error" && m ? [Number(m[1])] : [];
      });
      const first =
        res.issues.find((x) => x.severity === "error") ?? res.issues[0];
      message = first?.message ?? null;
      state = res.issues.some((x) => x.severity === "error") ? "bad" : "ok";
    } else {
      const res = textToRows(
        text,
        songTiming(song()),
        pattern()?.length ?? 0,
        startRowOf(orderIdx)
      );
      ({ errorAt } = res);
      message = res.error ?? res.warning;
      if (res.error) {
        state = "bad";
      } else if (res.dropped > 0) {
        state = "warn";
        message = `${res.dropped} rows past the end of the pattern were left out`;
      } else if (res.warning) {
        state = "warn";
      }
    }
    box.pre.innerHTML = mmlHighlight(text, errorAt);
    box.msg.textContent = message ?? "ok";
    box.msg.classList.toggle("bad", state === "bad");
    box.msg.classList.toggle("warn", state === "warn");
  }

  /** The typed text becomes the notes: a kept channel's MML, or the channel's rows in the pattern the box was showing. */
  function applyText(box: TextBox): void {
    const ci = song().channels.findIndex((x) => x.id === box.ch);
    const c = song().channels[ci];
    if (!c) {
      return;
    }
    const text = box.ta.value;
    selfMml = true;
    if (isKept(c)) {
      project.edit<Song>(
        doc(),
        (d) => {
          const ch = d.channels[ci];
          if (ch) {
            ch.mml = text;
          }
        },
        `mml:${c.id}`
      );
    } else {
      const length = song().patterns[box.pid]?.length ?? 0;
      const res = textToRows(text, songTiming(song()), length, box.start);
      if (!res.error) {
        project.edit<Song>(
          doc(),
          (d) => {
            const p = d.patterns[box.pid];
            if (!p) {
              return;
            }
            const rows = keepEffectRows(p.tracks[c.id] ?? [], res.rows);
            if (rows.length > 0) {
              p.tracks[c.id] = rows;
            } else {
              delete p.tracks[c.id];
            }
          },
          `mml:${c.id}:${box.pid}`
        );
      }
    }
    selfMml = false;
  }

  function makeTextBox(c: SongChannel): TextBox {
    const box = h("div", {
      class: "mml-box",
      style: `--kc:${KIND_COLOR[kindOf(c)]}`,
    });
    const top = h("div", { class: "mml-top" });
    top.innerHTML = `<b class="pxh"></b><span class="mml-msg mono"></span>`;
    const wrap = h("div", { class: "mml-wrap" });
    const pre = h("pre", { "aria-hidden": "true", class: "mml-hl" });
    const ta = h("textarea", {
      "aria-label": `Text (MML) of ${c.id}`,
      autocapitalize: "off",
      class: "mml-ta",
      placeholder: "Type notes here, for example: o4 l8 c d e f g",
      rows: 3,
      spellcheck: "false",
    }) as HTMLTextAreaElement;
    wrap.append(pre, ta);
    let note: HTMLElement | null = null;
    box.append(top);
    if (isKept(c)) {
      note = h(
        "p",
        { class: "mml-note" },
        `This channel stays as text (${keptReason()}), so its cells are read only. Edit it here.`
      );
      box.append(note);
    }
    box.append(wrap);
    const tb: TextBox = {
      ch: c.id,
      commit: debounce(() => applyText(tb), TEXT_COMMIT_MS),
      kept: isKept(c),
      label: top.querySelector("b") as HTMLElement,
      msg: top.querySelector(".mml-msg") as HTMLElement,
      note,
      pid: patternId(),
      pre,
      start: startRowOf(orderIdx),
      ta,
    };
    ta.addEventListener("input", () => {
      checkText(tb);
      tb.commit();
    });
    ta.addEventListener("blur", () => {
      tb.commit.flush();
      syncTexts();
    });
    ta.addEventListener("scroll", () => {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    });
    // typing must not play notes or move the cursor in the grid
    ta.addEventListener("keydown", (e) => e.stopPropagation());
    textPanel.append(box);
    textBoxes.set(c.id, tb);
    return tb;
  }

  /** Typing that has not reached the grid yet goes in now, into the pattern it was typed for. */
  function flushTexts(): void {
    for (const b of textBoxes.values()) {
      b.commit.flush();
    }
  }

  /** The boxes of the channels whose Text view is open, in channel order; each shows the selected pattern. */
  function buildTexts(): void {
    flushTexts();
    textPanel.replaceChildren();
    textBoxes.clear();
    const shown = song().channels.filter(showsText);
    textPanel.hidden = shown.length === 0;
    for (const c of shown) {
      const box = makeTextBox(c);
      box.label.textContent = labelOf(c);
      box.ta.value = textOf(c);
      checkText(box);
    }
  }

  /** The grid changed: the boxes show the notes again, except the one being typed in. */
  function syncTexts(): void {
    const shown = song().channels.filter(showsText);
    textPanel.hidden = shown.length === 0;
    const same =
      shown.length === textBoxes.size &&
      shown.every((c) => textBoxes.get(c.id)?.kept === isKept(c));
    if (!same) {
      buildTexts();
      return;
    }
    for (const c of shown) {
      const box = textBoxes.get(c.id);
      if (!box) {
        continue;
      }
      box.pid = patternId();
      box.start = startRowOf(orderIdx);
      box.label.textContent = labelOf(c);
      const text = textOf(c);
      if (document.activeElement !== box.ta && box.ta.value !== text) {
        box.ta.value = text;
      }
      checkText(box);
    }
  }

  /* ----- bar ----- */
  function syncBar(): void {
    const s = song();
    if (document.activeElement !== tempoIn) {
      tempoIn.value = String(s.tempo);
    }
    if (document.activeElement !== rpbIn) {
      rpbIn.value = String(s.rowsPerBeat);
    }
    if (document.activeElement !== lenIn) {
      lenIn.value = String(pattern()?.length ?? 0);
    }
    octEl.textContent = String(octave);
    followIn.checked = follow;
    ctx.setChip(s.chip);
  }
  function setOctave(o: number): void {
    octave = clamp(o, 0, 8);
    prefs.set("tracker-octave", octave);
    octEl.textContent = String(octave);
  }
  function setFollow(on: boolean): void {
    follow = on;
    prefs.set("tracker-follow", on);
    followIn.checked = on;
  }
  tempoIn.addEventListener("change", () => {
    project.edit<Song>(
      doc(),
      (d) => {
        d.tempo = clamp(Number(tempoIn.value) || 120, 20, 400);
      },
      "tempo"
    );
    engine.setTempo(song().tempo);
  });
  rpbIn.addEventListener("change", () => {
    project.edit<Song>(
      doc(),
      (d) => {
        d.rowsPerBeat = clamp(Math.round(Number(rpbIn.value) || 4), 1, 16);
      },
      "rpb"
    );
    rebuildAll();
  });
  lenIn.addEventListener("change", () => {
    const pid = patternId();
    project.edit<Song>(
      doc(),
      (d) => {
        const p = d.patterns[pid];
        if (p) {
          p.length = clamp(Math.round(Number(lenIn.value) || 32), 1, 256);
          for (const list of Object.values(p.tracks)) {
            for (let i = list.length - 1; i >= 0; i -= 1) {
              if ((list[i]?.row ?? 0) >= p.length) {
                list.splice(i, 1);
              }
            }
          }
        }
      },
      "plen"
    );
    rebuildAll();
  });
  for (const el of [tempoIn, rpbIn, lenIn]) {
    el.addEventListener("keydown", (e) => e.stopPropagation());
  }
  followIn.addEventListener("change", () => setFollow(followIn.checked));
  q("#gOctDn").addEventListener("click", () => setOctave(octave - 1));
  q("#gOctUp").addEventListener("click", () => setOctave(octave + 1));
  q("#gHelp").addEventListener("click", () =>
    openTrackerHelp(() => tracker.focus())
  );

  /* ----- playing ----- */
  const reloadSong = debounce(() => {
    if (engine.playing && !engine.hasSong(id)) {
      // another song is playing: an edit here must not cut it off or start this one at its position
      return;
    }
    if (engine.playing) {
      const pos = engine.position;
      loadSongDoc(doc());
      engine.playSong(pos ? { order: pos.order, row: pos.row } : {});
    } else {
      loadSongDoc(doc());
    }
  }, 250);

  function playFrom(order: number, row: number): void {
    paused = false;
    playSongDoc(doc(), { order, row });
  }
  function play(): void {
    if (!engine.hasSong(id)) {
      // the engine holds another song (played from the sidebar) or none (an instrument was previewed): start this one
      playFrom(orderIdx, 0);
    } else if (engine.playing) {
      engine.pauseSong();
      paused = true;
    } else if (paused && engine.position) {
      paused = false;
      engine.playSong({});
    } else {
      playFrom(orderIdx, 0);
    }
  }
  playBtn.addEventListener("click", play);
  q("#gHere").addEventListener("click", () => playFrom(orderIdx, cur.row));

  /* ----- inspector ----- */
  function songGroup(s: Song): HTMLElement {
    const gs = group("Song", { key: "song-song" });
    textField(gs.body, {
      label: "Name",
      onInput: (v) =>
        project.edit<Song>(
          doc(),
          (d) => {
            d.name = v;
          },
          "sname"
        ),
      value: s.name,
    });
    selectField<ChipId>(gs.body, {
      label: "Chip",
      onInput: (v) => fire(retarget(v)),
      options: CHIP_IDS.map((chip) => ({
        label: CHIP_THEME[chip].short,
        value: chip,
      })),
      value: s.chip,
    });
    selectField<"50" | "60">(gs.body, {
      label: "Tick rate",
      onInput: (v) =>
        project.edit<Song>(doc(), (d) => {
          d.tickRate = Number(v) as 50 | 60;
        }),
      options: ["60", "50"],
      value: String(s.tickRate) as "50" | "60",
    });
    rangeField(gs.body, {
      label: "Loop to order",
      max: Math.max(0, s.order.length - 1),
      min: 0,
      onInput: (v) =>
        project.edit<Song>(
          doc(),
          (d) => {
            d.loop = Math.round(v);
          },
          "loop"
        ),
      step: 1,
      value: s.loop ?? 0,
    });
    toggleField(gs.body, {
      label: "Loops",
      onInput: (on) => {
        project.edit<Song>(doc(), (d) => {
          d.loop = on ? Math.min(orderIdx, d.order.length - 1) : null;
        });
        buildOrder();
      },
      value: s.loop !== null,
    });
    return gs.el;
  }

  /** The echo's four knobs, shown while the echo is on. */
  function echoFields(
    gm: Group,
    echo: NonNullable<Song["master"]["echo"]>,
    why: string | false
  ): void {
    for (const [k, label, min, max, step] of [
      ["delay", "Delay (s)", 0.01, 1, 0.01],
      ["feedback", "Feedback", 0, 0.95, 0.01],
      ["level", "Level", 0, 1, 0.01],
      ["lowpassHz", "Lowpass (Hz)", 200, 12_000, 10],
    ] as const) {
      rangeField(gm.body, {
        label,
        max,
        min,
        off: why,
        onInput: (v) =>
          project.edit<Song>(
            doc(),
            (d) => {
              if (d.master.echo) {
                d.master.echo[k] = v;
              }
            },
            `echo${k}`
          ),
        step,
        value: echo[k],
      });
    }
  }

  /** The reverb's three knobs, shown while the reverb is on. */
  function reverbFields(
    gm: Group,
    reverb: NonNullable<Song["master"]["reverb"]>,
    why: string | false
  ): void {
    for (const [k, label] of [
      ["size", "Size"],
      ["damping", "Damping"],
      ["level", "Level"],
    ] as const) {
      rangeField(gm.body, {
        label,
        max: 1,
        min: 0,
        off: why,
        onInput: (v) =>
          project.edit<Song>(
            doc(),
            (d) => {
              if (d.master.reverb) {
                d.master.reverb[k] = v;
              }
            },
            `rev${k}`
          ),
        step: 0.01,
        value: reverb[k],
      });
    }
  }

  function masterGroup(s: Song): HTMLElement {
    const gm = group("Master", { key: "song-master" });
    const fxOk = chipProfile(s.chip).constraints.masterFx;
    const why = fxOk
      ? false
      : `${CHIP_THEME[s.chip].short} has no master effects`;
    rangeField(gm.body, {
      label: "Volume",
      max: 1,
      min: 0,
      onInput: (v) =>
        project.edit<Song>(
          doc(),
          (d) => {
            d.master.volume = v;
          },
          "mvol"
        ),
      step: 0.01,
      value: s.master.volume,
    });
    toggleField(gm.body, {
      label: "Echo",
      off: why,
      onInput: (on) => {
        project.edit<Song>(doc(), (d) => {
          d.master.echo = on
            ? { delay: 0.24, feedback: 0.35, level: 0.3, lowpassHz: 4000 }
            : null;
        });
        buildInspector();
      },
      value: s.master.echo !== null,
    });
    if (s.master.echo) {
      echoFields(gm, s.master.echo, why);
    }
    toggleField(gm.body, {
      label: "Reverb",
      off: why,
      onInput: (on) => {
        project.edit<Song>(doc(), (d) => {
          d.master.reverb = on
            ? { damping: 0.5, level: 0.25, size: 0.5 }
            : null;
        });
        buildInspector();
      },
      value: s.master.reverb !== null,
    });
    if (s.master.reverb) {
      reverbFields(gm, s.master.reverb, why);
    }
    if (s.chip === "amiga") {
      amigaFields(
        gm.body,
        s,
        doc,
        (fn, key) => project.edit<Song>(doc(), fn, key),
        buildInspector
      );
    }
    if (s.chip === "genesis") {
      genesisFields(
        gm.body,
        s,
        (fn, key) => project.edit<Song>(doc(), fn, key),
        buildInspector
      );
    }
    return gm.el;
  }

  /** The selected channel's instrument, volume and pan, and a button that opens its instrument. */
  function channelGroup(s: Song, c: SongChannel): HTMLElement[] {
    const gc = group(`Channel: ${c.id}`, { key: "song-chan" });
    const insts = project.list("instrument");
    const same = insts.filter((d) => (d.value as Instrument).kind === c.kind);
    const opts = [
      { label: "(none)", value: "" },
      ...(same.length ? same : insts).map((d) => ({
        label: `${hex(instList().indexOf(d.id), 2)} ${(d.value as Instrument).name}`,
        value: d.id,
      })),
    ];
    selectField<string>(gc.body, {
      label: "Instrument",
      onInput: (v) =>
        project.edit<Song>(doc(), (d) => {
          const ch = d.channels[cur.ch];
          if (ch) {
            ch.instrument = v === "" ? null : v;
          }
        }),
      options: opts,
      value: c.instrument ?? "",
    });
    rangeField(gc.body, {
      label: "Volume",
      max: 1,
      min: 0,
      onInput: (v) => {
        project.edit<Song>(
          doc(),
          (d) => {
            const ch = d.channels[cur.ch];
            if (ch) {
              ch.volume = v;
            }
          },
          `cvol${cur.ch}`
        );
        const idx = engineIndex(c.id);
        if (idx >= 0) {
          engine.setChannel(idx, { volume: v });
        }
      },
      step: 0.01,
      value: c.volume,
    });
    rangeField(gc.body, {
      label: "Pan",
      max: 1,
      min: -1,
      off:
        chipProfile(s.chip).constraints.pan === "none"
          ? `${CHIP_THEME[s.chip].short} has no pan`
          : false,
      onInput: (v) =>
        project.edit<Song>(
          doc(),
          (d) => {
            const ch = d.channels[cur.ch];
            if (ch) {
              ch.pan = v;
            }
          },
          `cpan${cur.ch}`
        ),
      step: 0.01,
      value: c.pan,
    });
    const out: HTMLElement[] = [gc.el];
    const open = c.instrument
      ? project.get("instrument", c.instrument)
      : undefined;
    if (open) {
      out.push(
        h(
          "div",
          { class: "hint btn-row" },
          h(
            "button",
            {
              class: "btn small",
              onclick: () => app.navigate(`#/instrument/${open.id}`),
            },
            `Open ${(open.value as Instrument).name}`
          )
        )
      );
    }
    return out;
  }

  /** The numbers the tracker shows for each instrument, as buttons that open it. */
  function instrumentLegend(): HTMLElement {
    const legend = h("div", { class: "hint inst-legend" });
    const il = instList();
    legend.append(h("b", {}, "Instrument numbers"));
    for (const [i, iid] of il.entries()) {
      const inst = project.instruments()[iid];
      const row = h("button", {
        class: "legend-row",
        onclick: () => app.navigate(`#/instrument/${iid}`),
        title: `Open ${iid}`,
      });
      row.innerHTML = `<span class="mono"></span><i style="background:${KIND_HEX[inst?.kind ?? "pulse"]}"></i><span class="nm"></span>`;
      (row.querySelector(".mono") as HTMLElement).textContent = hex(i, 2);
      (row.querySelector(".nm") as HTMLElement).textContent = inst?.name ?? iid;
      legend.append(row);
    }
    return legend;
  }

  function buildInspector(): void {
    insp.replaceChildren();
    const s = song();
    const inner = h("div", { class: "insp-in" });
    insp.append(inner);
    const slot = h("div", { class: "issue-slot" });
    showIssues(slot, doc().issues, (issue) => fixInstrumentButton(doc, issue));
    inner.append(slot, songGroup(s), masterGroup(s));
    const c = s.channels[cur.ch];
    if (c) {
      inner.append(...channelGroup(s, c));
    }
    inner.append(instrumentLegend());
    inner.append(
      h(
        "div",
        { class: "hint" },
        "Keys: Z S X D C V G B H N J M and Q 2 W 3 E R 5 T 6 Y 7 U play notes. 1 is note off, ` is release, Delete clears (the selected block, if there is one), Shift with the arrow keys selects a block, Ctrl C, X and V copy, cut and paste it, Ctrl Up and Down transpose it, - and = change octave, F follows the playhead while the cursor is in the note column. === is a note off, ^^^ a release. Press ? above the grid for the effect codes."
      )
    );
    inner.append(docActions(doc, "Delete song"));
  }

  /** The Chip control: ask, move the channels to the ones that suit the new chip (one undo step), then redraw. */
  async function retarget(chip: ChipId): Promise<void> {
    const changed = await changeSongChip(doc(), chip);
    if (changed) {
      rebuildAll();
    } else {
      // the person said no: the control goes back to the chip the song has
      buildInspector();
    }
  }

  function refreshAfterMml(): void {
    orderIdx = clamp(orderIdx, 0, Math.max(0, song().order.length - 1));
    if (refreshFxNeed()) {
      buildHead();
    }
    buildOrder();
    buildGrid();
    syncTexts();
    syncBar();
  }

  /* ----- rebuild ----- */
  function rebuildAll(): void {
    orderIdx = clamp(orderIdx, 0, Math.max(0, song().order.length - 1));
    refreshFxNeed();
    buildHead();
    buildOrder();
    buildGrid();
    syncTexts();
    syncBar();
    syncSolo();
    buildInspector();
  }

  const unsub = project.subscribe((e) => {
    if (e.type === "list" && !project.get("song", id)) {
      app.navigate("#/pads");
      return;
    }
    if (e.type !== "doc" || e.path !== doc()?.path) {
      return;
    }
    if (e.cause === "saved") {
      return;
    }
    reloadSong();
    showIssues(insp.querySelector(".issue-slot"), doc().issues, (issue) =>
      fixInstrumentButton(doc, issue)
    );
    if (e.cause === "edit" && selfSpan !== null) {
      const span = selfSpan;
      selfSpan = null;
      patchSpan(span);
      return;
    }
    if (e.cause === "edit" && selfMml) {
      // typing in a Text box: the grid shows the new notes; the text box itself stays as it is, so the caret does not jump
      refreshAfterMml();
      return;
    }
    // anything else (undo, outside change, structure edits) redraws everything but keeps the cursor
    const keep = { ...cur };
    rebuildAll();
    Object.assign(cur, keep);
    placeCursor();
  });

  /* ----- visuals ----- */
  const colorOf = (chId: string): string => {
    const c = song().channels.find((x) => x.id === chId);
    return c ? KIND_HEX[c.kind] : "#ece7da";
  };
  /** The strip keys each channel lit and has not put out yet. A note is announced twice (when it is played and when the
      engine makes it audible), so the engine's noteOn for an old key can arrive after a newer one was lit; a channel
      holds one note, so its noteOff puts out every key it lit. */
  const litNotes = new Map<number, Set<number>>();
  /** The note frequency of each channel's latest note, the period hint for its scope. */
  const hzOf = new Map<number, number>();
  /** Where the song is, from the engine's row events (they arrive when the row is audible, in order with the notes). */
  let evPos: { order: number; row: number } | null = null;
  /** The strip lights with the notes that start and fades the ones that end; a cell pulses for each note. */
  function lightNotes(f: Frame): void {
    const live = f.playing && engine.hasSong(id);
    for (const ev of f.events as readonly EngineEvent[]) {
      if (ev.type === "row" && live) {
        evPos = { order: ev.order, row: ev.row };
      }
      if (ev.channel < 0) {
        continue;
      }
      if (ev.type === "noteOn") {
        noteStarted(ev, f.time);
      } else if (ev.type === "noteOff") {
        noteEnded(ev.channel, f.time);
      }
    }
  }
  /** Light the key of a note that starts, remember it for the channel's noteOff, and pulse its cell. */
  function noteStarted(ev: EngineEvent, time: number): void {
    const n = clamp(Math.round(ev.note), KEY_LO, KEY_HI);
    keys.light(n, colorOf(ev.channelId), true, time);
    const lit = litNotes.get(ev.channel) ?? new Set<number>();
    lit.add(n);
    litNotes.set(ev.channel, lit);
    if (ev.hz > 0) {
      hzOf.set(ev.channel, ev.hz);
    }
    const at = evPos?.order === orderIdx ? evPos.row : playRow;
    pulseCell(ev.channelId, at);
  }
  /** A channel holds one note, so its noteOff puts out every key it lit. */
  function noteEnded(channel: number, time: number): void {
    for (const k of litNotes.get(channel) ?? []) {
      keys.release(k, time);
    }
    litNotes.delete(channel);
  }

  /** The order list marks the pattern that plays; with follow on, the grid moves to it. */
  function markPlayingOrder(order: number): void {
    playOrder = order;
    for (const [i, el] of orderEl.querySelectorAll(".ochip").entries()) {
      el.classList.toggle("playing", i === order);
    }
    keepOrderInView();
    if (follow && order !== orderIdx && order < song().order.length) {
      flushTexts();
      orderIdx = order;
      buildOrder();
      buildGrid();
      syncTexts();
      syncBar();
    }
  }

  /** `shown`: the song is this one and playing or paused, so the playhead stays where it is while paused. */
  function movePlayhead(f: Frame, shown: boolean): void {
    const pos = evPos ?? f.position;
    if (shown && pos) {
      if (pos.order !== playOrder) {
        markPlayingOrder(pos.order);
      }
      if (pos.row !== playRow || pos.order !== playOrderShown) {
        playRowEl(pos.order === orderIdx ? pos.row : -1);
        playOrderShown = pos.order;
      }
    } else if (playRow >= 0) {
      evPos = null;
      playRowEl(-1);
      playOrder = -1;
      for (const el of orderEl.querySelectorAll(".ochip.playing")) {
        el.classList.remove("playing");
      }
    }
  }

  function syncPlayButton(playing: boolean): void {
    playBtn.classList.toggle("on", playing);
    const lab = playBtn.querySelector("span");
    if (lab && lab.textContent !== (playing ? "Pause" : "Play")) {
      lab.textContent = playing ? "Pause" : "Play";
      playBtn.querySelector("svg")?.replaceWith(h("span", { class: "tmp" }));
      playBtn
        .querySelector(".tmp")
        ?.replaceWith(htmlIcon(playing ? "pause" : "play"));
    }
  }

  function drawKeys(f: Frame): void {
    if (keys.busy(f.time) || f.reduced || keysDirty) {
      keys.draw(f.time);
      keysDirty = false;
    }
  }

  const offVisual = addVisual((f) => {
    // another song's position means nothing in this grid
    const own = engine.hasSong(id);
    const mine = f.playing && own;
    lightNotes(f);
    movePlayhead(f, own && (f.playing || paused));
    syncPlayButton(mine);
    drawScopes(f);
    drawKeys(f);
  });
  let playOrderShown = -1;
  let keysDirty = true;
  const htmlIcon = (name: string): Node => {
    const t = document.createElement("template");
    t.innerHTML = icon(name, 16);
    return t.content.firstElementChild as Node;
  };

  function playRowEl(row: number): void {
    if (playRow >= 0) {
      rowEls[playRow]?.classList.remove("play");
    }
    playRow = row;
    const el = rowEls[row];
    if (!el) {
      return;
    }
    el.classList.add("play");
    if (follow) {
      const visible = Math.floor(
        (tracker.clientHeight - head.offsetHeight) / ROW_H
      );
      tracker.scrollTop = snapRow(row - Math.floor(visible * 0.35));
    }
  }
  function pulseCell(chId: string, row: number): void {
    if (row < 0) {
      return;
    }
    const ci = song().channels.findIndex((c) => c.id === chId);
    const tc = rowEls[row]?.querySelector<HTMLElement>(`.tc[data-ch="${ci}"]`);
    if (tc) {
      tc.classList.remove("pulse");
      reflow(tc);
      tc.classList.add("pulse");
    }
  }

  /** The last `frames` frames of a channel's sound, or null when nothing is to be drawn: not playing, reduced
      motion, a channel the engine has no scope for, or a scope that cannot be read. */
  function scopeWindow(
    e: (typeof scopeSurfs)[number],
    f: Parameters<Parameters<typeof addVisual>[0]>[0],
    frames: number
  ): Float32Array | null {
    const reader = engine.scopes;
    if (!reader || e.idx < 0 || !f.playing || f.reduced) {
      return null;
    }
    try {
      return reader.at(e.idx, f.frame - frames, frames);
    } catch {
      return null;
    }
  }

  /** The window a pitched channel's scope reads: long enough for two periods of its note (see scopeWindowFrames). */
  function pitchedWindow(
    e: (typeof scopeSurfs)[number],
    f: Parameters<Parameters<typeof addVisual>[0]>[0]
  ): number {
    const hz = hzOf.get(e.idx);
    const period = hz && hz > 20 ? f.sampleRate / hz : e.trig.period;
    return scopeWindowFrames(period);
  }

  /** A fixed bar texture scaled by the smoothed level: what a noise channel (or a sound with no period) draws. */
  function drawLevel(
    e: (typeof scopeSurfs)[number],
    f: Parameters<Parameters<typeof addVisual>[0]>[0],
    data: Float32Array,
    peak: number,
    color: string
  ): void {
    const { ctx: g, w, h: hh } = e.s;
    const mid = hh / 2;
    const columns = Math.ceil(w / LEVEL_COL_PX);
    if (e.level.heights.length !== columns) {
      e.level = createLevelState(columns);
    }
    updateLevel(e.level, data, f.dt, peak);
    const heights = columnHeights(e.level, mid - 2);
    for (let c = 0; c < heights.length; c += 1) {
      const x = c * LEVEL_COL_PX;
      const half = heights[c] ?? 0;
      const bw = Math.min(LEVEL_COL_PX, w - x);
      g.fillStyle = `${color}40`;
      g.fillRect(x, Math.floor(mid) - half - 1, bw, half * 2 + 3);
      g.fillStyle = color;
      g.fillRect(x, Math.floor(mid) - half, bw, Math.max(1, half * 2));
    }
  }

  /** The thin line a scope shows when there is nothing to trace: dim when silent, dimmer when muted. */
  function drawFlatline(
    e: (typeof scopeSurfs)[number],
    color: string,
    alpha: string
  ): void {
    const { ctx: g, w, h: hh } = e.s;
    g.fillStyle = `${color}${alpha}`;
    g.fillRect(0, Math.floor(hh / 2), w, 2);
  }

  /** The scope's backdrop: cleared, filled, with the center line. */
  function drawScopeBackdrop(e: (typeof scopeSurfs)[number]): void {
    const { ctx: g, w, h: hh } = e.s;
    g.clearRect(0, 0, w, hh);
    g.fillStyle = "#0e0d14";
    g.fillRect(0, 0, w, hh);
    g.fillStyle = "rgba(255,255,255,0.06)";
    g.fillRect(0, Math.floor(hh / 2), w, 1);
  }

  /** The locked trace of a pitched channel, one column of its spans at a time. */
  function drawTrace(
    e: (typeof scopeSurfs)[number],
    data: Float32Array,
    t: ReturnType<typeof locate>,
    color: string
  ): void {
    const { ctx: g, w, h: hh } = e.s;
    const { peak, spans } = scopeTraceAt(data, t.start, t.span, w, hh);
    for (let x = 0; x < w; x += 1) {
      const y0 = spans[x * 2] ?? 0;
      const y1 = spans[x * 2 + 1] ?? 0;
      g.fillStyle = `${color}40`;
      g.fillRect(x, y0 - 1, 1, y1 - y0 + 3);
      g.fillStyle = color;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0 + 1));
    }
    if (peak < 0.002) {
      drawFlatline(e, color, "88");
    }
  }

  /** The loudest of every eighth sample of `data` (0..1). */
  function sparsePeak(data: Float32Array): number {
    let peak = 0;
    for (let i = 0; i < data.length; i += 8) {
      peak = Math.max(peak, Math.abs(data[i] ?? 0));
    }
    return peak;
  }

  function drawScope(
    e: (typeof scopeSurfs)[number],
    f: Parameters<Parameters<typeof addVisual>[0]>[0]
  ): void {
    const color = KIND_HEX[e.ch.kind];
    drawScopeBackdrop(e);
    const muted = e.ch.muted || (solo.size > 0 && !solo.has(e.ch.id));
    const noise = e.ch.kind === "noise";
    // noise has no period to lock to: it never reads the long window or searches for one
    const frames = noise ? LEVEL_FRAMES : pitchedWindow(e, f);
    const data = scopeWindow(e, f, frames);
    if (!data || muted) {
      drawFlatline(e, color, muted ? "33" : "88");
      return;
    }
    let period = 0;
    let t: ReturnType<typeof locate> | null = null;
    if (!noise) {
      t = locate(e.trig, data, f.frame - frames, {
        sampleRate: f.sampleRate,
        targetSpan: SCOPE_SPAN,
        ...(hzOf.has(e.idx) ? { hintHz: hzOf.get(e.idx) as number } : {}),
      });
      ({ period } = t);
    }
    const peak = sparsePeak(data);
    if (levelMode(e.mode, noise, period, peak < 0.002) || !t) {
      drawLevel(e, f, data, peak, color);
      if (peak < 0.002) {
        drawFlatline(e, color, "88");
      }
      return;
    }
    drawTrace(e, data, t, color);
  }

  function drawScopes(f: Parameters<Parameters<typeof addVisual>[0]>[0]): void {
    for (const e of scopeSurfs) {
      drawScope(e, f);
    }
  }

  /* ----- start ----- */
  // scroll snapping lines rows up under the sticky header, whose height follows its content
  const headWatch = new ResizeObserver(() =>
    tracker.style.setProperty("--head-h", `${head.offsetHeight}px`)
  );
  headWatch.observe(head);
  rebuildAll();
  keys.draw();
  ctx.cleanup(() => {
    offVisual();
    unsub();
    headWatch.disconnect();
    reloadSong.cancel();
    for (const b of textBoxes.values()) {
      b.commit.cancel();
    }
    for (const e of scopeSurfs) {
      e.s.dispose();
    }
    keys.dispose();
    // solo is a session setting of the engine: clear it
    for (const c of solo) {
      const idx = engineIndex(c);
      if (idx >= 0) {
        engine.setChannel(idx, { solo: false });
      }
    }
  });
  loadSongDoc(doc());
  tracker.focus({ preventScroll: true });

  /** Paste from the palette: the block copied here (the system clipboard cannot be read without asking). */
  function pasteFromPalette(): void {
    const block = heldBlock();
    if (block) {
      pasteHeld(block);
    } else {
      app.toast("Nothing copied yet. Select some cells and press Ctrl C.");
    }
  }

  const blockCommands = (): Command[] => {
    const defs: [string, string, string, () => void, string][] = [
      [
        "selectall",
        "Select the channel, then the whole pattern",
        "eye",
        selectAll,
        "Ctrl A",
      ],
      [
        "copy",
        "Copy the selected cells",
        "copy",
        () => {
          copyBlock();
        },
        "Ctrl C",
      ],
      ["cut", "Cut the selected cells", "copy", cutBlock, "Ctrl X"],
      [
        "paste",
        "Paste the copied cells at the cursor",
        "copy",
        pasteFromPalette,
        "Ctrl V",
      ],
      ["clearsel", "Clear the selected cells", "trash", clearBlock, "Delete"],
      [
        "transup",
        "Transpose the selected notes up a semitone",
        "up",
        () => transposeBlock(1),
        "Ctrl Up",
      ],
      [
        "transdown",
        "Transpose the selected notes down a semitone",
        "down",
        () => transposeBlock(-1),
        "Ctrl Down",
      ],
      [
        "octup",
        "Transpose the selected notes up an octave",
        "up",
        () => transposeBlock(12),
        "Ctrl Shift Up",
      ],
      [
        "octdown",
        "Transpose the selected notes down an octave",
        "down",
        () => transposeBlock(-12),
        "Ctrl Shift Down",
      ],
    ];
    return defs.map(([name, title, ic, run, hint]) => ({
      enabled: () => !!pattern(),
      group: "Song",
      icon: ic,
      id: `song:${name}`,
      keys: hint,
      run,
      title,
    }));
  };

  const commands = (): Command[] => [
    {
      group: "Song",
      icon: "play",
      id: "song:play",
      keys: "Space",
      run: play,
      title: "Play or pause the song",
    },
    {
      group: "Song",
      icon: "right",
      id: "song:here",
      keys: "Enter",
      run: () => playFrom(orderIdx, cur.row),
      title: "Play from the cursor",
    },
    {
      group: "Song",
      icon: "eye",
      id: "song:follow",
      keys: "F (note column)",
      run: () => setFollow(!follow),
      title: "Toggle follow playhead",
    },
    ...blockCommands(),
    {
      group: "Song",
      icon: "plus",
      id: "song:newpat",
      run: addPattern,
      title: "Add an empty pattern",
    },
    {
      group: "Song",
      icon: "copy",
      id: "song:duppat",
      run: dupPattern,
      title: "Duplicate this pattern",
    },
    ...song().channels.map(
      (c): Command => ({
        group: "Song",
        icon: "mml",
        id: `song:text:${c.id}`,
        run: () => toggleText(c),
        title: `Show or hide the text (MML) of ${c.id}`,
      })
    ),
  ];

  return {
    chip: () => song().chip,
    commands,
    doc: () => doc(),
    onKey: (e) => {
      if (e.key === " ") {
        return false;
      }
      return onTrackerKey(e);
    },
    play,
    stop: stopEverything,
  };
}
