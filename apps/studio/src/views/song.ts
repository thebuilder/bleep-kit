/* The song editor: a Famitracker style tracker grid (one column per channel, colored by kind), an order list, tempo and
   rows per beat, per-channel scopes, mute and solo, MML channels with live error underlines, and a four octave strip
   that lights with the notes that play. The right-hand inspector holds the song and the selected channel. */
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
  type Row,
  type Song,
  type SongChannel,
} from "../lib/contract.ts";
import {
  chipChannels,
  chipProfile,
  formatEffect,
  mmlToTrack,
  noteName,
  parseEffect,
  parseMml,
  patternToMml,
} from "../lib/core.ts";
import { choose, clamp, debounce, h, prefs, reflow } from "../lib/dom.ts";
import {
  loadSongDoc,
  playInstrumentDoc,
  playSongDoc,
  stopEverything,
} from "../playback.ts";
import type { ViewCtx } from "../shell.ts";
import { type Doc, project } from "../state/docs.ts";
import {
  type Group,
  group,
  rangeField,
  selectField,
  textField,
  toggleField,
} from "../ui/fields.ts";
import { icon } from "../ui/icons.ts";
import { showIssues } from "../ui/issues.ts";
import { createPiano, keyToOffset } from "../ui/piano.ts";
import { surface, triggerIndex } from "../visuals/canvas.ts";
import { addVisual, type Frame } from "../visuals/loop.ts";

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

const hex = (n: number, d = 1) => n.toString(16).toUpperCase().padStart(d, "0");
/** Height of a tracker row in CSS pixels (.trow). */
const ROW_H = 20;
const KEY_LO = 36;
const KEY_HI = 83;

type Field = 0 | 1 | 2 | 3 | 4;
interface Cursor {
  ch: number;
  field: Field;
  row: number;
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

const noteCell = (r: Row | undefined) =>
  `<span class="n${NOTE_CLASS[String(r?.note)] ?? ""}" data-f="0">${noteText(r?.note ?? null)}</span>`;

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
  return `<span class="f${e ? "" : " e"}" data-f="${3 + k}">${text}</span>`;
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
  let selfRow: number | null = null;
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
        <label class="tgl-row" title="Scroll the grid with the playhead (F)"><span class="tgl"><input type="checkbox" id="gFollow"><span></span></span><small>Follow (F)</small></label>
      </div>
      <div class="orderbar" id="gOrder" role="list" aria-label="Order list"></div>
      <div class="tracker" id="gTracker" tabindex="0" aria-label="Tracker grid">
        <div class="tr-head" id="gHead"></div>
        <div class="tr-body" id="gBody"></div>
      </div>
      <div class="keystrip"><canvas id="gKeys" aria-label="Notes playing"></canvas></div>
      <div class="mml-panel" id="gMml"></div>
    </div>`;
  const q = <T extends HTMLElement>(sel: string) =>
    host.querySelector(sel) as T;
  const head = q("#gHead");
  const body = q("#gBody");
  const tracker = q("#gTracker");
  const orderEl = q("#gOrder");
  const mmlPanel = q("#gMml");
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
  });

  /* ----- lookups ----- */
  const patternId = () =>
    song().order[clamp(orderIdx, 0, Math.max(0, song().order.length - 1))] ??
    "";
  const pattern = () => song().patterns[patternId()];
  const rowsOf = (chId: string): Map<number, Row> => {
    const m = new Map<number, Row>();
    for (const r of pattern()?.tracks[chId] ?? []) {
      m.set(r.row, r);
    }
    return m;
  };
  const engineIndex = (chId: string) =>
    chipChannels(song()).findIndex((c) => c.id === chId);
  const fxCount = (chId: string) => clamp(fxCols[chId] ?? 1, 1, 2);
  const fieldCount = (chId: string): number => 3 + fxCount(chId);
  const kindOf = (c: SongChannel) => c.kind;

  /* ----- grid ----- */
  let rowEls: HTMLElement[] = [];
  let scopeSurfs: {
    ch: SongChannel;
    s: ReturnType<typeof surface>;
    idx: number;
  }[] = [];

  function cellHtml(c: SongChannel, r: Row | undefined): string {
    if (c.mml !== null) {
      return `<span class="n mml-cell">MML</span>`;
    }
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

  function patchRow(rowIdx: number): void {
    const el = rowEls[rowIdx];
    if (!el) {
      return;
    }
    const s = song();
    song();
    s.channels.forEach((c, ci) => {
      const tc = el.querySelector<HTMLElement>(`.tc[data-ch="${ci}"]`);
      if (tc) {
        tc.innerHTML = cellHtml(c, rowsOf(c.id).get(rowIdx));
      }
    });
    placeCursor();
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
          <button class="tb${c.mml === null ? "" : " on"}" data-act="mml" title="Write this channel in MML" aria-label="MML for ${c.id}">MML</button>
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
      scopeSurfs.push({ ch: c, idx, s: surface(cv) });
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
    const top = cur.row * ROW_H;
    const bottom = head.offsetHeight + (cur.row + 1) * ROW_H;
    if (tracker.scrollTop > top) {
      tracker.scrollTop = top;
    } else if (bottom - tracker.scrollTop > tracker.clientHeight) {
      tracker.scrollTop =
        Math.ceil((bottom - tracker.clientHeight) / ROW_H) * ROW_H;
    }
  }

  /* ----- order list ----- */
  function buildOrder(): void {
    const s = song();
    orderEl.replaceChildren();
    orderEl.append(h("span", { class: "pxh olab" }, "Order"));
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
      orderEl.append(chip);
    });
    const btn = (label: string, ic: string, title: string, fn: () => void) => {
      const b = h("button", {
        "aria-label": title,
        class: "btn small",
        onclick: fn,
        title,
      });
      b.innerHTML = `${icon(ic, 12)}<span>${label}</span>`;
      orderEl.append(b);
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
        if (d.loop !== null && d.loop >= d.order.length) {
          d.loop = d.order.length - 1;
        }
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
    orderEl.append(sel);
  }

  function setOrder(i: number): void {
    orderIdx = clamp(i, 0, Math.max(0, song().order.length - 1));
    cur.row = 0;
    buildOrder();
    buildGrid();
    syncBar();
    tracker.scrollTop = 0;
  }
  function moveOrder(from: number, to: number): void {
    project.edit<Song>(doc(), (d) => {
      const [x] = d.order.splice(from, 1);
      if (x !== undefined) {
        d.order.splice(to, 0, x);
      }
      if (d.loop === from) {
        d.loop = to;
      }
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
    selfRow = rowIdx;
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

  function audition(note: number): void {
    const d = instrumentFor(cur.ch, currentRow());
    if (d) {
      playInstrumentDoc(d, note, 0.35);
    }
  }

  function move(dRow: number, dCh = 0, dField = 0): void {
    const s = song();
    const len = pattern()?.length ?? 1;
    entry = "";
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

  /** The keys that mean the same in every field: octave down and up, follow. */
  function globalKey(k: string): boolean {
    if (k === "-" || k === "_") {
      setOctave(octave - 1);
    } else if (k === "=" || k === "+") {
      setOctave(octave + 1);
    } else if (k === "f" || k === "F") {
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
        `${code.toUpperCase()} is not an effect. Try A0F (arpeggio) or 0C4 style codes: a letter, then two hex digits.`
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
    if (navigationKey(e)) {
      return true;
    }
    if (k === "Delete" || k === "Backspace") {
      clearKey(c, k);
      return true;
    }
    if (e.shiftKey && k.length > 1) {
      return false;
    }
    if (globalKey(k)) {
      return true;
    }
    if (c.mml !== null) {
      return false;
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
  body.addEventListener("pointerdown", (e) => {
    const span = (e.target as HTMLElement).closest<HTMLElement>("[data-f]");
    const tc = (e.target as HTMLElement).closest<HTMLElement>(".tc");
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".trow");
    if (!(tc && rowEl)) {
      return;
    }
    entry = "";
    cur.row = Number(rowEl.dataset.r);
    cur.ch = Number(tc.dataset.ch);
    cur.field = (span ? Number(span.dataset.f) : 0) as Field;
    placeCursor();
    tracker.focus({ preventScroll: true });
  });
  tracker.addEventListener("keydown", (e) => {
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
    } else if (act === "mml") {
      toggleMml(ci);
    } else if (act === "fx") {
      fxCols = { ...fxCols, [c.id]: fxCount(c.id) === 1 ? 2 : 1 };
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
  function flatRows(chId: string): Row[] {
    const s = song();
    const out: Row[] = [];
    let base = 0;
    for (const pid of s.order) {
      const p = s.patterns[pid];
      for (const r of p?.tracks[chId] ?? []) {
        out.push({ ...r, fx: r.fx.map((x) => ({ ...x })), row: base + r.row });
      }
      base += p?.length ?? 0;
    }
    return out;
  }

  function toggleMml(ci: number): void {
    const c = song().channels[ci];
    if (!c) {
      return;
    }
    if (c.mml === null) {
      const text =
        patternToMml(flatRows(c.id), song().rowsPerBeat) || "o4 l8 r";
      project.edit<Song>(doc(), (d) => {
        const ch = d.channels[ci];
        if (!ch) {
          return;
        }
        ch.mml = text;
        for (const p of Object.values(d.patterns)) {
          delete p.tracks[c.id];
        }
      });
      app.toast(`${c.id} is now written in MML. Ctrl+Z undoes it.`);
    } else {
      convertBack(ci);
    }
    rebuildAll();
  }

  function convertBack(ci: number): void {
    const c = song().channels[ci];
    if (!c || c.mml === null) {
      return;
    }
    const res = mmlToTrack(c.mml, song().rowsPerBeat);
    const { rows } = res;
    project.edit<Song>(doc(), (d) => {
      const ch = d.channels[ci];
      if (!ch) {
        return;
      }
      let base = 0;
      for (const pid of d.order) {
        const p = d.patterns[pid];
        if (!p) {
          continue;
        }
        const mine = rows
          .filter((r) => r.row >= base && r.row < base + p.length)
          .map((r) => ({ ...r, row: r.row - base }));
        if (mine.length) {
          p.tracks[ch.id] = mine;
        } else {
          delete p.tracks[ch.id];
        }
        base += p.length;
      }
      ch.mml = null;
    });
    const lost = rows.filter(
      (r) =>
        r.row >=
        song().order.reduce(
          (n, pid) => n + (song().patterns[pid]?.length ?? 0),
          0
        )
    ).length;
    app.toast(
      lost
        ? `${c.id} is back in the tracker. ${lost} rows past the end were dropped.`
        : `${c.id} is back in the tracker.`
    );
  }

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

  function buildMml(): void {
    mmlPanel.replaceChildren();
    const chans = song()
      .channels.map((c, i) => ({ c, i }))
      .filter((x) => x.c.mml !== null);
    mmlPanel.hidden = chans.length === 0;
    for (const { c, i } of chans) {
      const box = h("div", {
        class: "mml-box",
        style: `--kc:${KIND_COLOR[kindOf(c)]}`,
      });
      const top = h("div", { class: "mml-top" });
      top.innerHTML = `<b class="pxh"></b><span class="mml-msg mono"></span>`;
      (top.querySelector("b") as HTMLElement).textContent = `${c.id} MML`;
      const toTracker = h(
        "button",
        {
          class: "btn small",
          onclick: () => {
            convertBack(i);
            rebuildAll();
          },
          title: "Convert this channel back to tracker rows",
        },
        "To tracker"
      );
      top.append(toTracker);
      const wrap = h("div", { class: "mml-wrap" });
      const pre = h("pre", { "aria-hidden": "true", class: "mml-hl" });
      const ta = h("textarea", {
        "aria-label": `MML for ${c.id}`,
        autocapitalize: "off",
        class: "mml-ta",
        rows: 3,
        spellcheck: "false",
      }) as HTMLTextAreaElement;
      ta.value = c.mml ?? "";
      const msg = top.querySelector(".mml-msg") as HTMLElement;
      const check = () => {
        const res = parseMml(ta.value);
        const errs: number[] = [];
        for (const iss of res.issues) {
          const m = OFFSET_IN_MESSAGE.exec(iss.message);
          if (m && iss.severity === "error") {
            errs.push(Number(m[1]));
          }
        }
        pre.innerHTML = mmlHighlight(ta.value, errs);
        const first =
          res.issues.find((x) => x.severity === "error") ?? res.issues[0];
        msg.textContent = first ? first.message : "ok";
        msg.classList.toggle(
          "bad",
          !!res.issues.find((x) => x.severity === "error")
        );
      };
      const commit = debounce(() => {
        selfMml = true;
        project.edit<Song>(
          doc(),
          (d) => {
            const ch = d.channels[i];
            if (ch) {
              ch.mml = ta.value;
            }
          },
          `mml:${c.id}`
        );
        selfMml = false;
      }, 160);
      ta.addEventListener("input", () => {
        check();
        commit();
      });
      ta.addEventListener("scroll", () => {
        pre.scrollTop = ta.scrollTop;
        pre.scrollLeft = ta.scrollLeft;
      });
      ta.addEventListener("keydown", (e) => e.stopPropagation());
      wrap.append(pre, ta);
      box.append(top, wrap);
      mmlPanel.append(box);
      check();
    }
  }
  let selfMml = false;

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

  /* ----- playing ----- */
  const reloadSong = debounce(() => {
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
    if (engine.playing) {
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
      onInput: (v) => retarget(v),
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
    showIssues(slot, doc().issues);
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
        "Keys: Z S X D C V G B H N J M and Q 2 W 3 E R 5 T 6 Y 7 U play notes. 1 is note off, ` is release, Delete clears, - and = change octave, F follows the playhead."
      )
    );
  }

  function retarget(chip: ChipId): void {
    const s = song();
    const next = { ...s, chip } as Song;
    const profile = chipChannels(next);
    project.edit<Song>(doc(), (d) => {
      d.chip = chip;
      const old = d.channels;
      d.channels = profile.map((pc) => {
        const prior =
          old.find((o) => o.id === pc.id) ??
          old.find((o) => o.kind === pc.kind);
        return {
          id: pc.id,
          instrument: prior?.instrument ?? null,
          kind: pc.kind,
          mml: prior?.mml ?? null,
          muted: prior?.muted ?? false,
          pan: prior?.pan ?? 0,
          volume: prior?.volume ?? 1,
        };
      });
      for (const p of Object.values(d.patterns)) {
        const keep: typeof p.tracks = {};
        for (const [cid, rows] of Object.entries(p.tracks)) {
          if (d.channels.some((c) => c.id === cid)) {
            keep[cid] = rows;
          }
        }
        p.tracks = keep;
      }
    });
    rebuildAll();
  }

  /* ----- rebuild ----- */
  function rebuildAll(): void {
    orderIdx = clamp(orderIdx, 0, Math.max(0, song().order.length - 1));
    buildHead();
    buildOrder();
    buildGrid();
    buildMml();
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
    showIssues(insp.querySelector(".issue-slot"), doc().issues);
    if (e.cause === "edit" && selfRow !== null) {
      const r = selfRow;
      selfRow = null;
      patchRow(r);
      return;
    }
    if (e.cause === "edit" && selfMml) {
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
  const lastNote = new Map<number, number>();
  const flashTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** The strip lights with the notes that start and fades the ones that end; a cell pulses for each note. */
  function lightNotes(f: Frame): void {
    for (const ev of f.events as readonly EngineEvent[]) {
      if (ev.channel < 0) {
        continue;
      }
      const n = clamp(Math.round(ev.note), KEY_LO, KEY_HI);
      if (ev.type === "noteOn") {
        keys.light(n, colorOf(ev.channelId), true, f.time);
        lastNote.set(ev.channel, n);
        pulseCell(ev.channelId);
      } else if (ev.type === "noteOff") {
        const held = lastNote.get(ev.channel);
        if (held !== undefined) {
          keys.release(held, f.time);
        }
      }
    }
  }

  /** The order list marks the pattern that plays; with follow on, the grid moves to it. */
  function markPlayingOrder(order: number): void {
    playOrder = order;
    for (const [i, el] of orderEl.querySelectorAll(".ochip").entries()) {
      el.classList.toggle("playing", i === order);
    }
    if (follow && order !== orderIdx && order < song().order.length) {
      orderIdx = order;
      buildOrder();
      buildGrid();
      syncBar();
    }
  }

  function movePlayhead(f: Frame): void {
    const pos = f.position;
    if (f.playing && pos) {
      if (pos.order !== playOrder) {
        markPlayingOrder(pos.order);
      }
      if (pos.row !== playRow || pos.order !== playOrderShown) {
        playRowEl(pos.order === orderIdx ? pos.row : -1, f.reduced);
        playOrderShown = pos.order;
      }
    } else if (playRow >= 0) {
      playRowEl(-1, true);
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
    lightNotes(f);
    movePlayhead(f);
    syncPlayButton(f.playing);
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

  function playRowEl(row: number, quiet: boolean): void {
    if (playRow >= 0) {
      rowEls[playRow]?.classList.remove("play", "flash");
    }
    playRow = row;
    const el = rowEls[row];
    if (!el) {
      return;
    }
    el.classList.add("play");
    if (!quiet) {
      el.classList.add("flash");
      clearTimeout(flashTimers.get(row));
      flashTimers.set(
        row,
        setTimeout(() => el.classList.remove("flash"), 80)
      );
    }
    if (follow) {
      const visible = Math.floor(
        (tracker.clientHeight - head.offsetHeight) / ROW_H
      );
      tracker.scrollTop = snapRow(row - Math.floor(visible * 0.35));
    }
  }
  function pulseCell(chId: string): void {
    if (playRow < 0) {
      return;
    }
    const ci = song().channels.findIndex((c) => c.id === chId);
    const tc = rowEls[playRow]?.querySelector<HTMLElement>(
      `.tc[data-ch="${ci}"]`
    );
    if (tc) {
      tc.classList.remove("pulse");
      reflow(tc);
      tc.classList.add("pulse");
    }
  }

  function drawScopes(f: Parameters<Parameters<typeof addVisual>[0]>[0]): void {
    const reader = engine.scopes;
    for (const e of scopeSurfs) {
      const { ctx: g, w, h: hh } = e.s;
      const color = KIND_HEX[e.ch.kind];
      g.clearRect(0, 0, w, hh);
      g.fillStyle = "#0e0d14";
      g.fillRect(0, 0, w, hh);
      g.fillStyle = "rgba(255,255,255,0.06)";
      g.fillRect(0, Math.floor(hh / 2), w, 1);
      const muted = e.ch.muted || (solo.size > 0 && !solo.has(e.ch.id));
      let data: Float32Array | null = null;
      if (reader && e.idx >= 0 && f.playing && !f.reduced) {
        try {
          data = reader.at(e.idx, f.frame - 1536, 1536);
        } catch {
          data = null;
        }
      }
      const mid = hh / 2;
      if (!data || muted) {
        g.fillStyle = `${color}${muted ? "33" : "88"}`;
        g.fillRect(0, Math.floor(mid), w, 2);
        continue;
      }
      const win = 512;
      const t = triggerIndex(data, win);
      let prevY = mid;
      let peak = 0;
      for (let x = 0; x < w; x += 1) {
        const i = t + Math.floor((x / w) * win);
        const v = clamp(data[i] ?? 0, -1, 1);
        peak = Math.max(peak, Math.abs(v));
        const y = Math.round(mid - v * (mid - 2));
        const y0 = Math.min(y, prevY);
        const y1 = Math.max(y, prevY);
        g.fillStyle = `${color}40`;
        g.fillRect(x, y0 - 1, 1, y1 - y0 + 3);
        g.fillStyle = color;
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0 + 1));
        prevY = y;
      }
      if (peak < 0.002) {
        g.fillStyle = `${color}88`;
        g.fillRect(0, Math.floor(mid), w, 2);
      }
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
    for (const e of scopeSurfs) {
      e.s.dispose();
    }
    keys.dispose();
    for (const [, t] of flashTimers) {
      clearTimeout(t);
    }
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
      keys: "F",
      run: () => setFollow(!follow),
      title: "Toggle follow playhead",
    },
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
      (c, i): Command => ({
        group: "Song",
        icon: "mml",
        id: `song:mml:${c.id}`,
        run: () => toggleMml(i),
        title: `Toggle MML for ${c.id}`,
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
