/* MOD export (architecture.md section 2.10): an amiga song becomes a 4 channel ProTracker module (M.K.). Each sample
   instrument becomes a MOD sample (the note shift that puts its pitch on ProTracker's table goes into the written notes,
   the remainder into the finetune), patterns longer than 64 rows are split, and Bleepkit's persistent effects are
   written again on every row, as a tracker needs them. What a MOD cannot hold is counted in a warning. */

import {
  AMIGA_CLOCK_HZ,
  MOD_NOTE_HIGH,
  MOD_NOTE_LOW,
  MOD_SAMPLE_RATE,
  PROTRACKER_PERIODS,
} from "../chips/amiga.ts";
import { generateSample } from "../samples/index.ts";
import {
  decodeSampleData,
  encodePcm,
  resample,
  scalePosition,
} from "../samples/user.ts";
import type {
  Effect,
  EffectType,
  Instrument,
  Issue,
  Pattern,
  Row,
  Song,
  UserSample,
} from "../types.ts";

export interface ModExport {
  /** The .mod file, null when the song cannot be exported (see `issues`). */
  bytes: Uint8Array | null;
  issues: Issue[];
}

const MOD_ROWS = 64;
const MAX_ORDER = 128;
const MAX_PATTERNS = 128;
const MAX_SAMPLES = 31;
const MAX_SAMPLE_BYTES = 131_070;
const HEADER = 1084;
const DEFAULT_SPEED = 6;
const PREFERRED_SPEEDS = [6, 3, 4, 5, 2, 8, 7, 1, 9, 10, 12, 16];

/* ---------- small helpers ---------- */

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

function issue(severity: Issue["severity"], message: string, path = ""): Issue {
  return { message, path, severity };
}

function ascii(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 63;
    out += c >= 32 && c < 127 ? ch : "?";
  }
  return out.slice(0, max);
}

function writeText(bytes: Uint8Array, at: number, text: string, max: number) {
  const t = ascii(text, max);
  for (let i = 0; i < t.length; i += 1) {
    bytes[at + i] = t.charCodeAt(i);
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/* ---------- samples ---------- */

interface ModSampleOut {
  data: Uint8Array;
  finetune: number;
  loopLength: number;
  loopStart: number;
  name: string;
  /** Semitones added to the Bleepkit note to get the MOD note. */
  shift: number;
  volume: number;
}

interface SourceAudio {
  baseNote: number;
  data: Float32Array;
  loop: { end: number; start: number } | null;
  rate: number;
  volume: number;
}

function sourceOf(
  inst: Instrument,
  samples: Record<string, UserSample>
): SourceAudio | null {
  const p = inst.sample;
  if (inst.kind !== "sample" || !p) {
    return null;
  }
  if (p.userSample !== undefined) {
    const s = samples[p.userSample];
    if (!s) {
      return null;
    }
    return {
      baseNote: s.baseNote - s.finetune / 100,
      data: decodeSampleData(s),
      loop: s.loop,
      rate: s.rate,
      volume: s.volume,
    };
  }
  const g = generateSample(p.generator, p.params, p.seed, 11_084);
  const loops =
    p.loop &&
    g.loopStart !== null &&
    g.loopEnd !== null &&
    g.loopEnd > g.loopStart;
  return {
    baseNote: p.baseNote,
    data: g.data,
    loop: loops ? { end: g.loopEnd ?? 0, start: g.loopStart ?? 0 } : null,
    rate: g.sampleRate,
    volume: 1,
  };
}

/** How many of the notes land on ProTracker's three octaves with the shift `s`. */
function inRange(notes: number[], s: number): number {
  let n = 0;
  for (const note of notes) {
    if (note + s >= MOD_NOTE_LOW && note + s <= MOD_NOTE_HIGH) {
      n += 1;
    }
  }
  return n;
}

function buildSample(
  inst: Instrument,
  src: SourceAudio,
  notes: number[],
  name: string,
  issues: Issue[]
): ModSampleOut {
  const lead = inst.transpose + inst.finetune / 100;
  const exact =
    lead + 36 - src.baseNote + 12 * Math.log2(src.rate / MOD_SAMPLE_RATE);
  let shift = Math.round(exact);
  let { data } = src;
  let { loop } = src;
  let octave = 0;
  if (notes.length > 0) {
    let best = inRange(notes, shift);
    for (const k of [12, -12, 24, -24]) {
      const score = inRange(notes, shift + k);
      if (score > best) {
        best = score;
        octave = k;
      }
    }
  }
  if (octave !== 0) {
    // Writing the notes `octave` higher needs 2^(octave/12) times as many frames to keep the pitch.
    const factor = 2 ** (octave / 12);
    const to = Math.max(1, Math.round(data.length * factor));
    data = resample(data, data.length, to);
    loop = loop
      ? {
          end: scalePosition(loop.end, src.data.length, to),
          start: scalePosition(loop.start, src.data.length, to),
        }
      : null;
    shift += octave;
    issues.push(
      issue(
        "info",
        `instrument "${name}" was resampled ${octave > 0 ? "up" : "down"} ${Math.abs(octave / 12)} octave(s) to bring its notes into ProTracker's range`
      )
    );
  }
  const finetune = clamp(Math.round((exact - Math.round(exact)) * 8), -8, 7);
  let bytes = encodePcm(data, 8);
  let loopStart = 0;
  let loopLength = 0;
  if (loop && loop.end - loop.start >= 4) {
    loopStart = Math.min(bytes.length, loop.start & ~1);
    loopLength = Math.max(
      2,
      (Math.min(bytes.length, loop.end) - loopStart) & ~1
    );
  }
  if (bytes.length > MAX_SAMPLE_BYTES) {
    issues.push(
      issue(
        "warning",
        `instrument "${name}" has ${bytes.length} frames, a MOD sample holds ${MAX_SAMPLE_BYTES}; it was cut`
      )
    );
    bytes = bytes.slice(0, MAX_SAMPLE_BYTES);
    loopLength = Math.min(loopLength, Math.max(0, bytes.length - loopStart));
    if (loopLength < 4) {
      loopLength = 0;
      loopStart = 0;
    }
  }
  if (bytes.length % 2 === 1) {
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    bytes = padded;
  }
  return {
    data: bytes,
    finetune,
    loopLength,
    loopStart,
    name,
    shift,
    volume: clamp(Math.round(64 * inst.volume * src.volume), 1, 64),
  };
}

/* ---------- timing ---------- */

interface Tempo {
  speed: number;
}

function chooseSpeed(song: Song, tempos: number[], issues: Issue[]): Tempo {
  let best = { bad: Number.POSITIVE_INFINITY, err: 0, speed: DEFAULT_SPEED };
  for (const speed of PREFERRED_SPEEDS) {
    let bad = 0;
    let err = 0;
    for (const t of tempos) {
      const b = (speed * t * song.rowsPerBeat) / 24;
      if (b < 32 || b > 255) {
        bad += 1;
      }
      err = Math.max(err, Math.abs(Math.round(b) - b) / b);
    }
    if (bad < best.bad || (bad === best.bad && err + 0.002 < best.err)) {
      best = { bad, err, speed };
    }
    if (bad === 0 && err < 0.004) {
      best = { bad, err, speed };
      break;
    }
  }
  if (best.bad > 0) {
    issues.push(
      issue(
        "warning",
        "some tempos of this song need a ProTracker BPM outside 32 to 255; they are clamped and run off"
      )
    );
  }
  return { speed: best.speed };
}

/* ---------- cells ---------- */

interface Cell {
  effect: number;
  param: number;
  period: number;
  /** Priority of the effect now in the cell: higher wins a conflict. */
  pri: number;
  sample: number;
}

const emptyCell = (): Cell => ({
  effect: 0,
  param: 0,
  period: 0,
  pri: -1,
  sample: 0,
});

interface Cand {
  effect: number;
  param: number;
  pri: number;
}

const PRI = {
  cont: 2,
  flow: 10,
  oneShot: 6,
  pitch: 1,
  vol: 4,
} as const;

interface ChanState {
  active: Map<EffectType, Effect>;
  colF: number;
  inst: string | null;
  modVol: number;
  period: number;
  sampleNo: number;
}

interface Env {
  bpm: number;
  counts: Map<string, number>;
  issues: Issue[];
  /** MOD sample number per instrument id. */
  numbers: Map<string, number>;
  samples: ModSampleOut[];
  song: Song;
  speed: number;
}

function scaleOf(env: Env): number {
  return ((env.speed - 1) / env.speed) * (env.bpm / 125);
}

/** The continuous effects of a channel, written for this row. */
function continuous(env: Env, st: ChanState, hasNote: boolean): Cand[] {
  const out: Cand[] = [];
  const scale = Math.max(0.05, scaleOf(env));
  const p = st.period > 0 ? st.period : 428;
  const a = st.active;
  const slide = a.get("slideUp") ?? a.get("slideDown");
  const porta = a.get("portamento");
  const vib = a.get("vibrato");
  const vol = a.get("volSlide");
  const refVol = Math.max(1, st.modVol);
  const volByte = (): number => {
    if (!vol) {
      return 0;
    }
    const n = vol.x > 0 ? vol.x : vol.y;
    const units = clamp(Math.round((n * refVol) / (16 * scale)), 1, 15);
    return vol.x > 0 ? units << 4 : units;
  };
  const bytes = (xx: number): number =>
    clamp(Math.round((xx * p) / (277.13 * scale)), 1, 255);
  if (porta) {
    const xx = porta.x * 16 + porta.y;
    out.push({
      effect: vol ? 5 : 3,
      param: vol ? volByte() : bytes(xx),
      pri: PRI.cont,
    });
  } else if (vib) {
    const sp = clamp(Math.round((vib.x * 125) / env.bpm), 1, 15);
    const dp = clamp(Math.round((vib.y * p) / 432.7), 1, 15);
    out.push({
      effect: vol ? 6 : 4,
      param: vol ? volByte() : (sp << 4) | dp,
      pri: PRI.cont,
    });
  } else if (vol) {
    out.push({ effect: 10, param: volByte(), pri: PRI.cont });
  }
  if (slide) {
    const up = a.has("slideUp");
    out.push({
      effect: up ? 1 : 2,
      param: bytes(slide.x * 16 + slide.y),
      pri: PRI.cont,
    });
  }
  const arp = a.get("arp");
  if (arp) {
    out.push({ effect: 0, param: (arp.x << 4) | arp.y, pri: PRI.cont - 0.5 });
  }
  const trem = a.get("tremolo");
  if (trem) {
    const sp = clamp(Math.round((trem.x * 125) / env.bpm), 1, 15);
    const dp = clamp(Math.round(trem.y / 1.87), 1, 15);
    out.push({ effect: 7, param: (sp << 4) | dp, pri: PRI.cont - 1 });
  }
  const rt = a.get("retrigger");
  if (rt && !hasNote) {
    const y = clamp(
      Math.round(((rt.x * 16 + rt.y) * env.bpm) / 125),
      1,
      env.speed - 1
    );
    out.push({
      effect: 14,
      param: 0x90 | clamp(y, 1, 15),
      pri: PRI.oneShot - 1,
    });
  }
  return out;
}

function tickOf(env: Env, ticks: number): number {
  return clamp(
    Math.round((ticks * env.bpm) / 125),
    1,
    Math.min(15, Math.max(1, env.speed - 1))
  );
}

/** Apply a row's effects to the channel state, returning the one-shot candidates it produces. */
function readEffects(
  env: Env,
  st: ChanState,
  fx: Effect[]
): {
  cands: Cand[];
  delayed: boolean;
  sampleOffset: boolean;
  pitchSet: Effect | null;
} {
  const cands: Cand[] = [];
  let delayed = false;
  let sampleOffset = false;
  let pitchSet: Effect | null = null;
  const toggle = (e: Effect, stopWhen: boolean): void => {
    if (stopWhen) {
      st.active.delete(e.type);
    } else {
      st.active.set(e.type, e);
    }
  };
  for (const e of fx) {
    const xx = e.x * 16 + e.y;
    switch (e.type) {
      case "arp":
        toggle(e, xx === 0);
        break;
      case "slideUp":
        st.active.delete("slideDown");
        toggle(e, xx === 0);
        break;
      case "slideDown":
        st.active.delete("slideUp");
        toggle(e, xx === 0);
        break;
      case "portamento":
      case "retrigger":
        toggle(e, xx === 0);
        break;
      case "vibrato":
      case "tremolo":
        toggle(e, e.x === 0 || e.y === 0);
        break;
      case "volSlide":
        toggle(e, xx === 0);
        break;
      case "cut":
        cands.push({
          effect: 14,
          param: 0xc0 | (xx === 0 ? 0 : tickOf(env, xx)),
          pri: PRI.oneShot,
        });
        break;
      case "delay":
        delayed = true;
        cands.push({
          effect: 14,
          param: 0xd0 | tickOf(env, xx),
          pri: PRI.oneShot,
        });
        break;
      case "sampleOffset":
        sampleOffset = true;
        cands.push({ effect: 9, param: xx, pri: PRI.oneShot + 1 });
        break;
      case "filter":
        cands.push({
          effect: 14,
          param: xx === 0 ? 0x01 : 0x00,
          pri: PRI.oneShot - 2,
        });
        break;
      case "pitch":
        pitchSet = e;
        break;
      case "noteSlideUp":
      case "noteSlideDown":
        bump(env.counts, "Qxy and Rxy note slides");
        break;
      case "pan":
        bump(env.counts, "Xxx pan");
        break;
      case "send":
        bump(env.counts, "Wxx echo send");
        break;
      case "duty":
        bump(env.counts, "Vxx duty");
        break;
      default:
        break;
    }
  }
  return { cands, delayed, pitchSet, sampleOffset };
}

/* ---------- the exporter ---------- */

interface Chunk {
  order: number;
  pattern: Pattern;
  rows: [number, number];
}

function usedNotes(
  song: Song,
  insts: Record<string, Instrument>
): { notes: Map<string, number[]>; order: string[] } {
  const notes = new Map<string, number[]>();
  const order: string[] = [];
  const see = (id: string, n: number | null): void => {
    if (!notes.has(id)) {
      notes.set(id, []);
      order.push(id);
    }
    if (n !== null) {
      notes.get(id)?.push(n);
    }
  };
  for (const pid of new Set(song.order)) {
    const pat = song.patterns[pid];
    if (!pat) {
      continue;
    }
    for (const ch of song.channels) {
      let cur = ch.instrument;
      for (const row of pat.tracks[ch.id] ?? []) {
        cur = row.inst ?? cur;
        if (cur !== null && insts[cur]) {
          see(cur, typeof row.note === "number" ? row.note : null);
        }
      }
    }
  }
  return { notes, order };
}

function chunksOf(song: Song): Chunk[] {
  const out: Chunk[] = [];
  song.order.forEach((pid, order) => {
    const pattern = song.patterns[pid] ?? { length: MOD_ROWS, tracks: {} };
    for (let from = 0; from < Math.max(1, pattern.length); from += MOD_ROWS) {
      out.push({
        order,
        pattern,
        rows: [from, Math.min(pattern.length, from + MOD_ROWS)],
      });
    }
  });
  return out;
}

function bcd(n: number): number {
  const v = clamp(n, 0, 63);
  return Math.floor(v / 10) * 16 + (v % 10);
}

/* ---------- planning ---------- */

interface FlowItem {
  /** The channel the effect came from, -1 for none. */
  chan: number;
  effect: number;
  param: number;
}

interface Plan {
  bpmOf: (tempo: number) => number;
  chanVol: number[];
  chunks: Chunk[];
  env: Env;
  instruments: Record<string, Instrument>;
  muted: boolean[];
  slotOf: Map<number, number>;
  states: ChanState[];
  tempoNow: number;
}

const CHANNEL_IDS = ["ch1", "ch2", "ch3", "ch4"];
const FIT_MESSAGE = "effects that did not fit the single effect of a MOD cell";

function collectSamples(
  song: Song,
  instruments: Record<string, Instrument>,
  samples: Record<string, UserSample>,
  issues: Issue[]
): { numbers: Map<string, number>; out: ModSampleOut[] } {
  const { notes, order } = usedNotes(song, instruments);
  const out: ModSampleOut[] = [];
  const numbers = new Map<string, number>();
  for (const id of order) {
    const inst = instruments[id];
    const src = inst ? sourceOf(inst, samples) : null;
    if (!(inst && src)) {
      issues.push(
        issue(
          "warning",
          `instrument "${id}" is not a sample instrument (or its sample is missing); its notes are left out of the MOD`
        )
      );
      continue;
    }
    if (out.length >= MAX_SAMPLES) {
      issues.push(
        issue(
          "warning",
          `a MOD holds 31 samples; instrument "${id}" and later ones are left out`
        )
      );
      break;
    }
    out.push(
      buildSample(inst, src, notes.get(id) ?? [], inst.name || id, issues)
    );
    numbers.set(id, out.length);
  }
  return { numbers, out };
}

/** Every tempo the song uses: its own and each tempo effect. */
function tempoList(song: Song): number[] {
  const tempos = [song.tempo];
  for (const pat of Object.values(song.patterns)) {
    for (const rows of Object.values(pat.tracks)) {
      for (const r of rows) {
        for (const e of r.fx) {
          if (e.type === "tempo") {
            tempos.push(e.x * 16 + e.y);
          }
        }
      }
    }
  }
  return tempos;
}

function makePlan(
  song: Song,
  instruments: Record<string, Instrument>,
  numbers: Map<string, number>,
  outSamples: ModSampleOut[],
  issues: Issue[]
): Plan {
  const { speed } = chooseSpeed(song, tempoList(song), issues);
  const bpmOf = (t: number): number =>
    clamp(Math.round((speed * t * song.rowsPerBeat) / 24), 32, 255);
  let chunks = chunksOf(song);
  if (chunks.length > MAX_ORDER) {
    issues.push(
      issue(
        "warning",
        `a MOD order list holds 128 entries; the song has ${chunks.length}, the rest is cut`
      )
    );
    chunks = chunks.slice(0, MAX_ORDER);
  }
  const slotOf = new Map<number, number>();
  chunks.forEach((c, slot) => {
    if (!slotOf.has(c.order)) {
      slotOf.set(c.order, slot);
    }
  });
  for (const ch of song.channels) {
    if (!CHANNEL_IDS.includes(ch.id)) {
      issues.push(
        issue(
          "warning",
          `channel "${ch.id}" is not an Amiga channel and is left out`
        )
      );
    }
  }
  const find = (id: string) => song.channels.find((c) => c.id === id);
  return {
    bpmOf,
    chanVol: CHANNEL_IDS.map((id) => find(id)?.volume ?? 1),
    chunks,
    env: {
      bpm: bpmOf(song.tempo),
      counts: new Map(),
      issues,
      numbers,
      samples: outSamples,
      song,
      speed,
    },
    instruments,
    muted: CHANNEL_IDS.map((id) => find(id)?.muted ?? false),
    slotOf,
    states: CHANNEL_IDS.map((id) => ({
      active: new Map(),
      colF: 1,
      inst: find(id)?.instrument ?? null,
      modVol: 64,
      period: 0,
      sampleNo: 0,
    })),
    tempoNow: song.tempo,
  };
}

/* ---------- one channel of one row ---------- */

interface RowCtx {
  c: number;
  cell: Cell;
  chunk: Chunk;
  flow: FlowItem[];
  slot: number;
  /** The Bleepkit row index in the pattern. */
  src: number;
}

/** Turn a Bleepkit note into the cell's period and sample. Returns whether the sample was (re)triggered. */
function writeNote(
  plan: Plan,
  st: ChanState,
  rc: RowCtx,
  note: number
): boolean {
  const { env } = plan;
  const sampleNo = st.inst === null ? 0 : (env.numbers.get(st.inst) ?? 0);
  const inst = st.inst === null ? undefined : plan.instruments[st.inst];
  if (sampleNo === 0 || !inst) {
    bump(env.counts, "notes without a sample instrument");
    return false;
  }
  const out = env.samples[sampleNo - 1];
  const m = clamp(
    note + (out?.shift ?? 0),
    MOD_NOTE_LOW - 12,
    MOD_NOTE_HIGH + 12
  );
  if (m < MOD_NOTE_LOW || m > MOD_NOTE_HIGH) {
    bump(env.counts, "notes outside C-1 to B-3 (held at the edge)");
  }
  const table =
    PROTRACKER_PERIODS[clamp(m, MOD_NOTE_LOW, MOD_NOTE_HIGH) - MOD_NOTE_LOW] ??
    428;
  rc.cell.period = table;
  st.period = table;
  if (st.active.has("portamento")) {
    return false;
  }
  rc.cell.sample = sampleNo;
  st.sampleNo = sampleNo;
  st.modVol = out?.volume ?? 64;
  return true;
}

/** Row level effects (tempo, jump, skip, halt) become flow items. */
function readFlow(plan: Plan, rc: RowCtx, fx: Effect[]): void {
  const { chunk, slot, c } = rc;
  const { slotOf, chunks } = plan;
  const { song } = plan.env;
  for (const e of fx) {
    const xx = e.x * 16 + e.y;
    if (e.type === "tempo") {
      plan.tempoNow = xx;
      plan.env.bpm = plan.bpmOf(xx);
      rc.flow.push({ chan: c, effect: 15, param: plan.env.bpm });
    } else if (e.type === "jump") {
      rc.flow.push({ chan: c, effect: 11, param: slotOf.get(xx) ?? 0 });
    } else if (e.type === "halt") {
      rc.flow.push({ chan: c, effect: 15, param: 0 });
    } else if (e.type === "skip") {
      const natural =
        chunks[slot + 1]?.order !== chunk.order &&
        chunks[slot + 1] !== undefined;
      if (!natural) {
        const next =
          slotOf.get(chunk.order + 1) ?? slotOf.get(song.loop ?? 0) ?? 0;
        rc.flow.push({ chan: c, effect: 11, param: next });
      }
      rc.flow.push({ chan: c, effect: 13, param: bcd(xx) });
    }
  }
}

/** The volume candidate: Cxx when the wanted MOD volume differs from the one the player has. */
function volumeCand(
  plan: Plan,
  st: ChanState,
  c: number,
  row: Row | undefined,
  triggered: boolean
): Cand[] {
  if (st.active.has("volSlide")) {
    const v = st.active.get("volSlide");
    if (v) {
      const ticks = (50 * 60) / (plan.tempoNow * plan.env.song.rowsPerBeat);
      st.colF = clamp(st.colF + ((v.x - v.y) / 16) * ticks, 0, 1);
    }
    return [];
  }
  if (!(triggered || (row !== undefined && row.vol !== null))) {
    return [];
  }
  const base = plan.env.samples[st.sampleNo - 1]?.volume ?? 64;
  const want = clamp(
    Math.round(base * (plan.chanVol[c] ?? 1) * st.colF),
    0,
    64
  );
  if (want === st.modVol) {
    return [];
  }
  st.modVol = want;
  return [{ effect: 12, param: want, pri: PRI.vol }];
}

/** The fine pitch effect as E1y or E2y. */
function pitchCand(st: ChanState, e: Effect): Cand[] {
  const d = (e.x * 16 + e.y - 128) / 16;
  const p = st.period > 0 ? st.period : 428;
  const delta = Math.round(Math.abs(p - p / 2 ** (Math.abs(d) / 12)));
  if (delta === 0) {
    return [];
  }
  return [
    {
      effect: 14,
      param: (d > 0 ? 0x10 : 0x20) | clamp(delta, 1, 15),
      pri: PRI.pitch,
    },
  ];
}

/** The note column of a row: an Bleepkit note value, or off. */
function noteCands(
  plan: Plan,
  st: ChanState,
  rc: RowCtx,
  row: Row | undefined
): { cands: Cand[]; note: number | null; triggered: boolean } {
  const value = row?.note ?? null;
  if (typeof value === "number") {
    const hadRetrig = st.active.has("retrigger");
    const triggered = writeNote(plan, st, rc, value);
    if (hadRetrig && !row?.fx.some((e) => e.type === "retrigger")) {
      st.active.delete("retrigger");
    }
    return { cands: [], note: value, triggered };
  }
  if (value === "off" || value === "release") {
    st.active.clear();
    st.modVol = 0;
    return {
      cands: [{ effect: 12, param: 0, pri: PRI.vol + 1 }],
      note: null,
      triggered: false,
    };
  }
  return { cands: [], note: null, triggered: false };
}

function channelRow(plan: Plan, rc: RowCtx): void {
  const st = plan.states[rc.c];
  if (!st) {
    return;
  }
  const row = rc.chunk.pattern.tracks[CHANNEL_IDS[rc.c] ?? ""]?.find(
    (x) => x.row === rc.src
  );
  if (row?.inst) {
    st.inst = row.inst;
  }
  if (row && row.vol !== null) {
    st.colF = row.vol / 15;
  }
  readFlow(plan, rc, row?.fx ?? []);
  const read = readEffects(plan.env, st, row?.fx ?? []);
  const nc = noteCands(plan, st, rc, row);
  const cands: Cand[] = [
    ...read.cands,
    ...nc.cands,
    ...volumeCand(plan, st, rc.c, row, nc.triggered),
    ...continuous(plan.env, st, nc.note !== null),
    ...(read.pitchSet ? pitchCand(st, read.pitchSet) : []),
  ];
  if (plan.muted[rc.c]) {
    rc.cell.period = 0;
    rc.cell.sample = 0;
  }
  cands.sort((a, b) => b.pri - a.pri);
  const [pick] = cands;
  if (pick) {
    Object.assign(rc.cell, {
      effect: pick.effect,
      param: pick.param,
      pri: pick.pri,
    });
    for (let k = 1; k < cands.length; k += 1) {
      bump(plan.env.counts, FIT_MESSAGE);
    }
  }
}

/** Put the row level effects in a free cell, preferably their own channel's, else the weakest effect's. */
function placeFlows(
  cells: Cell[],
  flows: FlowItem[],
  counts: Map<string, number>
): void {
  for (const f of flows) {
    let target = f.chan >= 0 && (cells[f.chan]?.pri ?? 0) < 0 ? f.chan : -1;
    let low = Number.POSITIVE_INFINITY;
    cells.forEach((candidate, i) => {
      if (target < 0 && candidate.pri < low) {
        low = candidate.pri;
        target = i;
      }
    });
    const cell = cells[target];
    if (cell) {
      if (cell.pri >= 0) {
        bump(counts, FIT_MESSAGE);
      }
      Object.assign(cell, { effect: f.effect, param: f.param, pri: PRI.flow });
    }
  }
}

/* ---------- chunks to MOD patterns ---------- */

/** The rows of one chunk as MOD cells. */
function chunkCells(plan: Plan, chunk: Chunk, slot: number): Cell[][] {
  const cells: Cell[][] = Array.from({ length: MOD_ROWS }, () =>
    CHANNEL_IDS.map(emptyCell)
  );
  const [from, to] = chunk.rows;
  for (let r = 0; r < to - from; r += 1) {
    const flow: FlowItem[] = [];
    if (slot === 0 && r === 0) {
      if (plan.env.speed !== DEFAULT_SPEED) {
        flow.push({ chan: -1, effect: 15, param: plan.env.speed });
      }
      if (plan.env.bpm !== 125) {
        flow.push({ chan: -1, effect: 15, param: plan.env.bpm });
      }
    }
    const rowCells = cells[r] ?? [];
    rowCells.forEach((cell, c) => {
      channelRow(plan, { c, cell, chunk, flow, slot, src: from + r });
    });
    placeFlows(rowCells, flow, plan.env.counts);
  }
  endBreak(cells, to - from);
  return cells;
}

/** A pattern shorter than 64 rows ends with a break to the next order entry. */
function endBreak(cells: Cell[][], rows: number): void {
  if (rows >= MOD_ROWS) {
    return;
  }
  const last = cells[rows - 1] ?? [];
  if (last.some((c) => c.effect === 13 || c.effect === 11)) {
    return;
  }
  let free = 0;
  last.forEach((c, i) => {
    if (c.pri < (last[free]?.pri ?? 0)) {
      free = i;
    }
  });
  const cell = last[free];
  if (cell) {
    Object.assign(cell, { effect: 13, param: 0, pri: PRI.flow });
  }
}

function encodeCells(cells: Cell[][]): Uint8Array {
  const buf = new Uint8Array(MOD_ROWS * 4 * 4);
  cells.forEach((rowCells, r) => {
    rowCells.forEach((cell, c) => {
      const o = (r * 4 + c) * 4;
      buf[o] = (cell.sample & 0xf0) | (cell.period >> 8);
      buf[o + 1] = cell.period & 255;
      buf[o + 2] = ((cell.sample & 15) << 4) | cell.effect;
      buf[o + 3] = cell.param;
    });
  });
  return buf;
}

/** The distinct MOD patterns and the order list that plays them. */
function buildPatterns(plan: Plan): {
  order: number[];
  patterns: Uint8Array[];
} {
  const patterns: Uint8Array[] = [];
  const byContent = new Map<string, number>();
  const order: number[] = [];
  plan.chunks.forEach((chunk, slot) => {
    const buf = encodeCells(chunkCells(plan, chunk, slot));
    const key = buf.join(",");
    let index = byContent.get(key);
    if (index === undefined) {
      index = patterns.length;
      byContent.set(key, index);
      patterns.push(buf);
    }
    order.push(index);
  });
  return { order, patterns };
}

/** A song that plays once ends with the stop command on its last row (a MOD player loops otherwise). */
function addStop(
  plan: Plan,
  built: { order: number[]; patterns: Uint8Array[] }
): void {
  const lastChunk = plan.chunks.at(-1);
  const last = built.patterns[built.order.at(-1) ?? 0];
  if (!(lastChunk && last)) {
    return;
  }
  const copy = last.slice();
  const at = (lastChunk.rows[1] - lastChunk.rows[0] - 1) * 16;
  copy[at + 2] = ((copy[at + 2] ?? 0) & 0xf0) | 15;
  copy[at + 3] = 0;
  built.patterns.push(copy);
  built.order[built.order.length - 1] = built.patterns.length - 1;
}

/* ---------- the file ---------- */

function putWord(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = (value >> 8) & 255;
  bytes[at + 1] = value & 255;
}

function writeHeader(
  bytes: Uint8Array,
  song: Song,
  samples: ModSampleOut[]
): void {
  writeText(bytes, 0, song.name, 20);
  samples.forEach((s, i) => {
    const o = 20 + i * 30;
    const looped = s.loopLength > 0;
    writeText(bytes, o, s.name, 22);
    putWord(bytes, o + 22, s.data.length / 2);
    bytes[o + 24] = s.finetune & 15;
    bytes[o + 25] = s.volume;
    putWord(bytes, o + 26, looped ? s.loopStart / 2 : 0);
    putWord(bytes, o + 28, looped ? s.loopLength / 2 : 1);
  });
  for (let i = samples.length; i < MAX_SAMPLES; i += 1) {
    bytes[20 + i * 30 + 29] = 1;
  }
  writeText(bytes, 1080, "M.K.", 4);
}

function writeFile(
  plan: Plan,
  built: { order: number[]; patterns: Uint8Array[] },
  samples: ModSampleOut[]
): Uint8Array {
  const dataLen = samples.reduce((n, s) => n + s.data.length, 0);
  const bytes = new Uint8Array(HEADER + built.patterns.length * 1024 + dataLen);
  writeHeader(bytes, plan.env.song, samples);
  bytes[950] = built.order.length;
  const { loop } = plan.env.song;
  const restart = loop === null ? 0 : (plan.slotOf.get(loop) ?? 0);
  bytes[951] = restart === 0 ? 127 : restart;
  built.order.forEach((p, i) => {
    bytes[952 + i] = p;
  });
  let at = HEADER;
  for (const p of built.patterns) {
    bytes.set(p, at);
    at += p.length;
  }
  for (const s of samples) {
    bytes.set(s.data, at);
    at += s.data.length;
  }
  return bytes;
}

/** Export an amiga song as a 4 channel ProTracker module. `bytes` is null (with an error issue) when it cannot. */
export function songToMod(
  song: Song,
  instruments: Record<string, Instrument>,
  samples: Record<string, UserSample>
): ModExport {
  if (song.chip !== "amiga") {
    return {
      bytes: null,
      issues: [
        issue(
          "error",
          `only amiga songs export to MOD (this song is "${song.chip}"); change the song's chip to amiga first`
        ),
      ],
    };
  }
  const issues: Issue[] = [];
  const { numbers, out } = collectSamples(song, instruments, samples, issues);
  const plan = makePlan(song, instruments, numbers, out, issues);
  const built = buildPatterns(plan);
  if (song.loop === null) {
    addStop(plan, built);
  }
  if (built.patterns.length > MAX_PATTERNS) {
    issues.push(
      issue(
        "error",
        `the song needs ${built.patterns.length} distinct MOD patterns, a MOD holds 128`
      )
    );
    return { bytes: null, issues };
  }
  const bytes = writeFile(plan, built, out);
  const { counts } = plan.env;
  if (counts.size > 0) {
    const list = [...counts.entries()]
      .map(([k, v]) => `${k} (${v}x)`)
      .join(", ");
    issues.push(issue("warning", `not written to the MOD: ${list}`));
  }
  issues.push(
    issue(
      "info",
      `wrote ${bytes.length} bytes: ${out.length} sample(s), ${built.patterns.length} pattern(s), ${built.order.length} order entries; speed ${plan.env.speed}, BPM ${plan.bpmOf(song.tempo)}, ${AMIGA_CLOCK_HZ} Hz PAL clock`
    )
  );
  return { bytes, issues };
}
