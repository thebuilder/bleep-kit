/* midiToSong: a Standard MIDI File to a Bleepkit song and the instruments it plays. See architecture.md section 2.8. */

import { CHIPS } from "../chips/index.ts";
import { defaultSong } from "../normalize/defaults.ts";
import { effectFromByte } from "../normalize/effects.ts";
import { normalizeSong } from "../normalize/index.ts";
import type {
  ChipChannel,
  ChipId,
  Effect,
  Instrument,
  Issue,
  Song,
} from "../types.ts";
import { type BuiltChannel, buildPatterns } from "./build.ts";
import {
  type Built,
  drumInstrument,
  type Role,
  roleInstrument,
  roleOf,
} from "./instruments.ts";
import { type MidiFile, parseMidi } from "./parse.ts";
import {
  assignParts,
  buildParts,
  type Part,
  type PartInfo,
  partInfo,
} from "./parts.ts";
import { type ChipPlan, channelRange, type DrumVoice, PLANS } from "./plan.ts";
import {
  type Grid,
  type GridNote,
  gridError,
  type Reduced,
  reduceDrums,
  reduceMelodic,
  tickToRow,
  toGrid,
} from "./reduce.ts";

export interface MidiToSongOptions {
  /** Target chip (default "nes"). */
  chip?: ChipId;
  /** Loop the song from the start (default true); false plays it once. */
  loop?: boolean;
  /**
   * Which MIDI parts go to which chip channels: `{ "1": "pulse1", "2": "triangle", "10": "noise" }`. A key is a MIDI
   * channel (1 to 16), a track (`t2`) or a track's channel (`t2ch1`); a value is a chip channel id, or `-` to leave
   * the part out. Parts the map does not mention are placed automatically on the channels it leaves free.
   */
  map?: Record<string, string>;
  /** Song name (default "Imported MIDI"). */
  name?: string;
  /** Rows per quarter note, 1 to 16 (default 4, sixteenth notes). */
  rowsPerBeat?: number;
}

export interface MidiImport {
  /** Instruments the song uses, by id; none of them exists yet. Write them next to the song. */
  instruments: Record<string, Instrument>;
  /** What was lost or changed, and anything wrong with the file. An `error` means there is no usable song. */
  issues: Issue[];
  /** Every part of the file with the chip channel it went to (null: dropped). */
  parts: PartInfo[];
  song: Song;
}

const DEFAULT_ROWS_PER_BEAT = 4;
const DEFAULT_PATTERN_ROWS = 64;
const MAX_PATTERN_ROWS = 256;
const MIN_TEMPO = 20;
const MAX_TEMPO = 400;
const MIN_TEMPO_FX = 32;
const MAX_TEMPO_FX = 255;
const OFF_GRID = 0.25;
const OFF_GRID_SHARE = 0.1;
const CHANNEL_VOLUMES: Record<Role, number> = {
  bass: 1,
  drums: 0.7,
  harmony: 0.8,
  lead: 1,
};

function issue(
  severity: Issue["severity"],
  path: string,
  message: string
): Issue {
  return { message, path, severity };
}

function failure(chip: ChipId, issues: Issue[]): MidiImport {
  return { instruments: {}, issues, parts: [], song: defaultSong(chip) };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/* ---------- positions ---------- */

interface Meter {
  beatsPerBar: number;
  ppq: number;
}

/** "bar 5 beat 2" for a tick, in the first time signature of the file (4/4 when it has none). */
function where(meter: Meter, tick: number): string {
  const beat = Math.floor(tick / meter.ppq);
  const bar = Math.floor(beat / meter.beatsPerBar) + 1;
  return `bar ${bar} beat ${(beat % meter.beatsPerBar) + 1}`;
}

function meterOf(file: MidiFile): Meter {
  const [first] = file.timeSignatures;
  const beatsPerBar = first ? (first.numerator * 4) / first.denominator : 4;
  return { beatsPerBar, ppq: file.ppq };
}

/* ---------- per channel ---------- */

interface Channel {
  built: BuiltChannel;
  channel: ChipChannel;
  instruments: Built[];
  parts: Part[];
  reduced: Reduced;
  role: Role;
}

/** Chooses the instruments of a channel and, for drums on a sample chip, one per drum that is hit. */
function channelInstruments(
  chip: ChipId,
  channel: ChipChannel,
  role: Role,
  drumsHit: DrumVoice[]
): { drumInstrument: BuiltChannel["drumInstrument"]; list: Built[] } {
  if (role === "drums" && channel.kind === "sample") {
    const kit = new Map<string, Built>();
    for (const voice of drumsHit) {
      kit.set(voice.generator, drumInstrument(chip, channel, voice));
    }
    const first = kit.values().next().value as Built | undefined;
    return {
      drumInstrument: (v) => kit.get(v.generator)?.id ?? first?.id ?? "",
      list: [...kit.values()],
    };
  }
  return { drumInstrument: null, list: [roleInstrument(chip, channel, role)] };
}

function reduceChannel(
  grid: Grid,
  chip: ChipId,
  channel: ChipChannel,
  parts: Part[],
  isBass: boolean,
  asDrums: boolean
): Reduced {
  const notes: GridNote[] = parts.flatMap((p) =>
    p.notes.map((n) => toGrid(grid, p, n))
  );
  return asDrums
    ? reduceDrums(notes)
    : reduceMelodic(notes, {
        bass: isBass,
        range: channelRange(chip, channel.id, channel.kind),
      });
}

function buildChannel(
  grid: Grid,
  chip: ChipId,
  plan: ChipPlan,
  channel: ChipChannel,
  parts: Part[]
): Channel {
  const drumsUsed = parts.some((p) => p.drums);
  const asDrums =
    channel.kind === "noise" || (channel.id === plan.drums && drumsUsed);
  const role = roleOf(plan, channel.id, asDrums);
  const reduced = reduceChannel(
    grid,
    chip,
    channel,
    parts,
    role === "bass",
    asDrums
  );
  const hit = reduced.events.flatMap((e) => (e.drum ? [e.drum] : []));
  const { drumInstrument: byDrum, list } = channelInstruments(
    chip,
    channel,
    role,
    hit
  );
  return {
    built: {
      drumInstrument: byDrum,
      events: reduced.events,
      id: channel.id,
      volume: channel.kind !== "triangle",
    },
    channel,
    instruments: list,
    parts,
    reduced,
    role,
  };
}

/* ---------- issues ---------- */

function lossIssues(c: Channel, meter: Meter): Issue[] {
  const { loss } = c.reduced;
  const at = `/channels/${c.channel.id}`;
  const out: Issue[] = [];
  if (loss.dropped > 0) {
    const what =
      c.role === "drums"
        ? "drum hits dropped (one drum per row: kick and snare win over toms, cymbals and hats)"
        : `notes dropped (chords and notes on one row keep only the ${c.role === "bass" ? "lowest" : "top"} note)`;
    const first =
      loss.firstDropped === null
        ? ""
        : `, first at ${where(meter, loss.firstDropped)}`;
    out.push(
      issue("warning", at, `${c.channel.id}: ${loss.dropped} ${what}${first}`)
    );
  }
  if (loss.shortened > 0) {
    out.push(
      issue(
        "warning",
        at,
        `${c.channel.id}: ${plural(loss.shortened, "note was", "notes were")} cut short because the next note started before it ended`
      )
    );
  }
  if (loss.shiftOctaves !== 0) {
    const dir = loss.shiftOctaves > 0 ? "up" : "down";
    out.push(
      issue(
        "warning",
        at,
        `${c.channel.id}: transposed ${dir} ${plural(Math.abs(loss.shiftOctaves), "octave")} to fit the channel's range`
      )
    );
  }
  if (loss.folded > 0) {
    out.push(
      issue(
        "warning",
        at,
        `${c.channel.id}: ${plural(loss.folded, "note")} moved by octaves to fit the channel's range`
      )
    );
  }
  return out;
}

function droppedPartIssues(
  dropped: { part: Part; reason: string }[],
  chip: ChipId
): Issue[] {
  return dropped.map(({ part, reason }) => {
    const label = part.name ? `${part.ref} "${part.name}"` : part.ref;
    return issue(
      "warning",
      "",
      `part ${label} (${plural(part.notes.length, "note")}) was left out on ${chip}: ${reason}`
    );
  });
}

function gridIssue(
  grid: Grid,
  notes: { tick: number }[],
  rowsPerBeat: number
): Issue[] {
  const off = notes.filter((n) => gridError(grid, n.tick) > OFF_GRID).length;
  if (notes.length === 0 || off / notes.length <= OFF_GRID_SHARE) {
    return [];
  }
  const finer = rowsPerBeat < 8 ? "8 or 12" : "12 or 16";
  return [
    issue(
      "warning",
      "",
      `${off} of ${notes.length} notes start more than a quarter row off the grid and were moved to the nearest row; a finer grid such as rowsPerBeat ${finer} keeps their timing`
    ),
  ];
}

/* ---------- tempo ---------- */

function songTempo(file: MidiFile, issues: Issue[]): number {
  const bpm = file.tempos[0]?.bpm ?? 120;
  const tempo = Math.round(bpm * 100) / 100;
  if (tempo < MIN_TEMPO || tempo > MAX_TEMPO) {
    issues.push(
      issue(
        "warning",
        "/tempo",
        `tempo ${tempo} BPM is outside ${MIN_TEMPO} to ${MAX_TEMPO}, it was limited`
      )
    );
  }
  return Math.max(MIN_TEMPO, Math.min(MAX_TEMPO, tempo));
}

/** Tempo changes after the first as tempo effects by row (whole BPM, 32 to 255), plus a restore on row 0 for loops. */
function tempoEffects(
  file: MidiFile,
  grid: Grid,
  totalRows: number,
  issues: Issue[]
): Map<number, Effect> {
  const out = new Map<number, Effect>();
  const rest = file.tempos.slice(1);
  let clamped = 0;
  const byteOf = (bpm: number) => {
    const b = Math.round(bpm);
    clamped += b < MIN_TEMPO_FX || b > MAX_TEMPO_FX ? 1 : 0;
    return Math.max(MIN_TEMPO_FX, Math.min(MAX_TEMPO_FX, b));
  };
  for (const t of rest) {
    const row = tickToRow(grid, t.tick);
    if (row < totalRows) {
      out.set(row, effectFromByte("tempo", byteOf(t.bpm)));
    }
  }
  if (out.size > 0 && !out.has(0)) {
    // a loop starts again at row 0: say what the first tempo was
    out.set(0, effectFromByte("tempo", byteOf(file.tempos[0]?.bpm ?? 120)));
  }
  if (clamped > 0) {
    issues.push(
      issue(
        "warning",
        "",
        `${plural(clamped, "tempo change")} outside 32 to 255 BPM were limited (tempo effects hold whole BPM in that range)`
      )
    );
  }
  return out;
}

/* ---------- length and pattern size ---------- */

/** Rows in a bar of the first time signature, and so the rows of a pattern: whole bars, up to 64 rows. */
function patternRows(meter: Meter, rowsPerBeat: number): number {
  const bar = Math.max(1, Math.round(meter.beatsPerBar * rowsPerBeat));
  const bars = Math.max(1, Math.floor(DEFAULT_PATTERN_ROWS / bar));
  return Math.min(MAX_PATTERN_ROWS, bar * bars);
}

/** The song ends with its last note, extended to the end of the bar when the file's own end allows it. */
function songRows(
  file: MidiFile,
  meter: Meter,
  grid: Grid,
  lastStartRow: number
): number {
  const lastEnd = file.notes.reduce((m, n) => Math.max(m, n.end), 0);
  const barTicks = meter.beatsPerBar * meter.ppq;
  const bar = Math.ceil(lastEnd / barTicks) * barTicks;
  const ticks = Math.max(lastEnd, Math.min(file.endTick, bar));
  return Math.max(tickToRow(grid, ticks), lastStartRow + 1, 1);
}

/** Offs past the end of the song move onto its last row (or go, when that row already holds the note). */
function fitEnd(events: Reduced["events"], totalRows: number): void {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (!e || e.row < totalRows) {
      continue;
    }
    const prev = events[i - 1];
    if (e.note === "off" && prev && prev.row < totalRows - 1) {
      e.row = totalRows - 1;
    } else {
      events.splice(i, 1);
    }
  }
}

/* ---------- the song ---------- */

function checkOptions(chip: ChipId, rowsPerBeat: number): Issue[] {
  const issues: Issue[] = [];
  if (chip === "custom" || !(chip in PLANS)) {
    issues.push(
      issue(
        "error",
        "/chip",
        `chip "${chip}" cannot be imported into: pick one of ${Object.keys(PLANS).join(", ")}`
      )
    );
  }
  if (
    !(Number.isInteger(rowsPerBeat) && rowsPerBeat >= 1 && rowsPerBeat <= 16)
  ) {
    issues.push(
      issue(
        "error",
        "/rowsPerBeat",
        `rowsPerBeat must be a whole number from 1 to 16 (was ${rowsPerBeat})`
      )
    );
  }
  return issues;
}

interface Setup {
  chip: ChipId;
  grid: Grid;
  plan: ChipPlan;
}

function layOut(
  file: MidiFile,
  setup: Setup,
  map: Record<string, string>,
  issues: Issue[]
): { channels: Channel[]; parts: PartInfo[] } {
  const { chip, grid, plan } = setup;
  const profile = CHIPS[chip].channels;
  const parts = buildParts(file);
  const assignment = assignParts(
    parts,
    plan,
    profile.map((c) => c.id),
    map,
    issues
  );
  issues.push(...droppedPartIssues(assignment.dropped, chip));
  const channels: Channel[] = [];
  for (const channel of profile) {
    const onChannel = assignment.byChannel.get(channel.id);
    if (onChannel) {
      channels.push(buildChannel(grid, chip, plan, channel, onChannel));
    }
  }
  const target = new Map<Part, string>();
  for (const [id, list] of assignment.byChannel) {
    for (const p of list) {
      target.set(p, id);
    }
  }
  return {
    channels,
    parts: parts.map((p) => partInfo(p, target.get(p) ?? null)),
  };
}

function assembleSong(
  file: MidiFile,
  setup: Setup,
  opts: MidiToSongOptions,
  laid: Channel[],
  issues: Issue[]
): { instruments: Record<string, Instrument>; song: Song } {
  const { chip, grid } = setup;
  const meter = meterOf(file);
  const lastStart = laid.reduce(
    (m, c) =>
      c.built.events.reduce(
        (mm, e) => (e.note === "off" ? mm : Math.max(mm, e.row)),
        m
      ),
    0
  );
  const totalRows = songRows(file, meter, grid, lastStart);
  for (const c of laid) {
    fitEnd(c.built.events, totalRows);
  }
  const length = patternRows(meter, grid.rowsPerBeat);
  const plan = buildPatterns({
    channels: laid.map((c) => c.built),
    patternLength: length,
    tempo: tempoEffects(file, grid, totalRows, issues),
    totalRows,
  });
  if (plan.truncatedAt !== null) {
    issues.push(
      issue(
        "warning",
        "/order",
        `the song is longer than 256 patterns: it was cut at row ${plan.truncatedAt}`
      )
    );
  }
  const instruments: Record<string, Instrument> = {};
  const song = defaultSong(chip);
  song.name = opts.name ?? "Imported MIDI";
  song.tempo = songTempo(file, issues);
  song.rowsPerBeat = grid.rowsPerBeat;
  for (const sc of song.channels) {
    const c = laid.find((x) => x.channel.id === sc.id);
    if (!c) {
      continue;
    }
    for (const b of c.instruments) {
      instruments[b.id] = b.instrument;
    }
    sc.instrument = c.instruments[0]?.id ?? null;
    sc.volume = CHANNEL_VOLUMES[c.role];
  }
  song.patterns = plan.patterns;
  song.order = plan.order;
  song.loop = opts.loop === false ? null : 0;
  return { instruments, song };
}

/**
 * Imports a Standard MIDI File. Channel 10 becomes the chip's drums, the lowest busy part the bass, the busiest high
 * part the lead and the rest fill the remaining channels; every channel plays one note at a time (chords keep the top
 * note, the bass keeps the lowest), notes are rounded to rows, velocity becomes the volume column, tempo comes from
 * the file, and notes move by octaves into each channel's range. Whatever that loses is listed in `issues`.
 */
export function midiToSong(
  bytes: Uint8Array,
  opts: MidiToSongOptions = {}
): MidiImport {
  const chip = opts.chip ?? "nes";
  const rowsPerBeat = opts.rowsPerBeat ?? DEFAULT_ROWS_PER_BEAT;
  const bad = checkOptions(chip, rowsPerBeat);
  if (bad.length > 0) {
    return failure(chip === "custom" || !(chip in PLANS) ? "nes" : chip, bad);
  }
  const file = parseMidi(bytes);
  const issues: Issue[] = [...file.issues];
  if (issues.some((i) => i.severity === "error")) {
    return failure(chip, issues);
  }
  const setup: Setup = {
    chip,
    grid: { ppq: file.ppq, rowsPerBeat },
    plan: PLANS[chip as keyof typeof PLANS],
  };
  const { channels, parts } = layOut(file, setup, opts.map ?? {}, issues);
  if (issues.some((i) => i.severity === "error")) {
    return failure(chip, issues);
  }
  const { instruments, song } = assembleSong(
    file,
    setup,
    opts,
    channels,
    issues
  );
  const meter = meterOf(file);
  for (const c of channels) {
    issues.push(...lossIssues(c, meter));
  }
  const kept = channels.flatMap((c) =>
    c.parts.flatMap((p) => p.notes.map((n) => ({ tick: n.start })))
  );
  issues.push(...gridIssue(setup.grid, kept, rowsPerBeat));
  const [first] = file.timeSignatures;
  if (
    first &&
    file.timeSignatures.some(
      (t) =>
        t.numerator !== first.numerator || t.denominator !== first.denominator
    )
  ) {
    issues.push(
      issue(
        "warning",
        "",
        "the time signature changes during the song: patterns follow the first one"
      )
    );
  }
  const normalized = normalizeSong(song, instruments);
  issues.push(...normalized.issues);
  return { instruments, issues, parts, song: normalized.value };
}
