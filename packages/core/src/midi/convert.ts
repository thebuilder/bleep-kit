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
import { type ChordHost, type ChordStats, placeChords } from "./chords.ts";
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
  CHORD_MODES,
  type ChordMode,
  emptyLoss,
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
  /**
   * What happens to the notes of a chord, which a channel cannot play together (default "auto"). `spread` puts the
   * extra notes on channels that are free at that moment, `arpeggio` turns them into a `0xy` arpeggio on the part's
   * own channel, `auto` spreads first and arpeggiates what is left, `top` keeps only one note (the top one, the lowest
   * on the bass) and drops the rest.
   */
  chords?: ChordMode;
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
  /**
   * What was converted (severity `info`: chords that became arpeggios or spread to other channels), what was lost or
   * changed (`warning`), and anything wrong with the file (`error` means there is no usable song).
   */
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

/** One chip channel while the song is built: the parts on it, its notes, and what happened to its chords. */
interface Channel {
  built: BuiltChannel;
  channel: ChipChannel;
  instruments: Built[];
  /** Names of the parts on it, for messages ("piano", or the part's reference when it has no name). */
  label: string;
  parts: Part[];
  reduced: Reduced;
  role: Role;
  stats: ChordStats;
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

/** A chip channel before its chords are placed: notes reduced to one line, chords waiting. */
interface Lane {
  asDrums: boolean;
  channel: ChipChannel;
  order: number;
  parts: Part[];
  reduced: Reduced;
  role: Role;
}

function reduceLane(
  setup: Setup,
  channel: ChipChannel,
  order: number,
  parts: Part[]
): Lane {
  const { chip, grid, plan } = setup;
  const drumsUsed = parts.some((p) => p.drums);
  const asDrums =
    channel.kind === "noise" || (channel.id === plan.drums && drumsUsed);
  const role = roleOf(plan, channel.id, asDrums);
  const notes: GridNote[] = parts.flatMap((p) =>
    p.notes.map((n) => toGrid(grid, p, n))
  );
  let reduced: Reduced = { chords: [], events: [], loss: emptyLoss() };
  if (parts.length > 0) {
    reduced = asDrums
      ? reduceDrums(notes)
      : reduceMelodic(notes, {
          bass: role === "bass",
          chords: setup.chords,
          range: channelRange(chip, channel.id, channel.kind),
        });
  }
  return { asDrums, channel, order, parts, reduced, role };
}

/** The names of the parts on a channel, for messages. */
function partsLabel(parts: Part[]): string {
  return parts.map((p) => p.name ?? p.ref).join(" and ");
}

function buildChannel(setup: Setup, lane: Lane, stats: ChordStats): Channel {
  const { chip } = setup;
  const { channel, parts, reduced, role } = lane;
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
    label: partsLabel(parts),
    parts,
    reduced,
    role,
    stats,
  };
}

/**
 * Channels that may take spread chord notes: the harmony channels (never the lead, the bass or the drums the file
 * really has). A drum channel that can play melody counts when the file has no drums.
 */
function openChannels(plan: ChipPlan, drumsUsed: boolean): Set<string> {
  const open = new Set(plan.melodic.slice(1));
  if (plan.drumsFlex && !drumsUsed) {
    open.add(plan.drums);
  }
  return open;
}

/** Places the chords of every lane (spread, arpeggio) and builds the channels that play something. */
function placeAndBuild(setup: Setup, lanes: Lane[]): Channel[] {
  const mode = setup.chords;
  const drumsUsed = lanes.some((l) => l.asDrums && l.parts.length > 0);
  const open = openChannels(setup.plan, drumsUsed);
  const hosts: ChordHost[] = lanes.map((l) => ({
    chords: l.reduced.chords,
    events: l.reduced.events,
    id: l.channel.id,
    kind: l.channel.kind,
    loss: l.reduced.loss,
    open: mode !== "arpeggio" && !l.asDrums && open.has(l.channel.id),
    order: l.order,
    range: channelRange(setup.chip, l.channel.id, l.channel.kind),
  }));
  const stats =
    mode === "top" ? new Map<string, ChordStats>() : placeChords(hosts, mode);
  const none = (): ChordStats => ({
    arps: 0,
    folded: 0,
    spread: 0,
    targets: new Map(),
  });
  return lanes
    .filter((l) => l.parts.length > 0 || l.reduced.events.length > 0)
    .map((l) => buildChannel(setup, l, stats.get(l.channel.id) ?? none()));
}

/* ---------- issues ---------- */

/** Why notes were dropped, in the words of the chord mode that dropped them. */
function droppedWhat(c: Channel, mode: ChordMode): string {
  if (c.role === "drums") {
    return "drum hits dropped (one drum per row: the kick wins over the snare, toms, then hats and cymbals; equal drums keep the louder hit)";
  }
  const keep = c.role === "bass" ? "lowest" : "top";
  if (mode === "top") {
    return `notes dropped (chords and notes on one row keep only the ${keep} note)`;
  }
  if (mode === "spread") {
    return `chord notes dropped (no free channel to spread them to: the channel keeps the ${keep} note)`;
  }
  return "chord notes dropped (an arpeggio holds three notes, and a pitch that repeats is not played twice)";
}

/** Names of channels as a list: "pulse2", "fm3 and fm4", "fm3, fm4 and fm5". */
function joinNames(names: string[]): string {
  if (names.length <= 1) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What became of the chords of a channel: arpeggios on it, notes spread to others. Converted, not lost. */
function chordIssues(c: Channel): Issue[] {
  const { arps, folded, spread, targets } = c.stats;
  const { id } = c.channel;
  const pieces: string[] = [];
  if (arps > 0) {
    pieces.push(
      `${plural(arps, "chord")} on ${c.label} became ${arps === 1 ? "an arpeggio" : "arpeggios"} on ${id}`
    );
  }
  if (spread > 0) {
    const to = joinNames([...targets.keys()]);
    pieces.push(
      `${plural(spread, "chord")}${pieces.length === 0 ? ` on ${c.label}` : ""} spread to ${to}`
    );
  }
  if (pieces.length === 0) {
    return [];
  }
  const fold =
    folded > 0
      ? `; ${plural(folded, "arpeggio interval")} folded down by octaves to fit 0 to 15 semitones`
      : "";
  return [issue("info", `/channels/${id}`, `${pieces.join(", ")}${fold}`)];
}

function lossIssues(c: Channel, meter: Meter, mode: ChordMode): Issue[] {
  const { loss } = c.reduced;
  const at = `/channels/${c.channel.id}`;
  const out: Issue[] = [];
  if (loss.dropped > 0) {
    const what = droppedWhat(c, mode);
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

function checkOptions(
  chip: ChipId,
  rowsPerBeat: number,
  chords: string
): Issue[] {
  const issues: Issue[] = [];
  if (!(CHORD_MODES as readonly string[]).includes(chords)) {
    issues.push(
      issue(
        "error",
        "/chords",
        `chords must be one of ${CHORD_MODES.join(", ")} (was "${chords}")`
      )
    );
  }
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
  chords: ChordMode;
  grid: Grid;
  plan: ChipPlan;
}

function layOut(
  file: MidiFile,
  setup: Setup,
  map: Record<string, string>,
  issues: Issue[]
): { channels: Channel[]; parts: PartInfo[] } {
  const { chip, plan } = setup;
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
  const lanes = profile.map((channel, order) =>
    reduceLane(
      setup,
      channel,
      order,
      assignment.byChannel.get(channel.id) ?? []
    )
  );
  const channels = placeAndBuild(setup, lanes);
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
  if (plan.tempoSkipped.length > 0) {
    issues.push(
      issue(
        "warning",
        "",
        `${plural(plan.tempoSkipped.length, "tempo change")} could not be written: the row already holds 4 effects (first at row ${Math.min(...plan.tempoSkipped)})`
      )
    );
  }
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
 * part the lead and the rest fill the remaining channels. Every channel plays one note at a time, so a chord is spread
 * over free channels and what is left becomes an arpeggio (`chords`, default "auto"; "top" keeps the top note, the
 * bass its lowest). Notes are rounded to rows, velocity becomes the volume column, tempo comes from the file, and notes
 * move by octaves into each channel's range. What was converted (`info`) and what was lost (`warning`) is listed in
 * `issues`.
 */
export function midiToSong(
  bytes: Uint8Array,
  opts: MidiToSongOptions = {}
): MidiImport {
  const chip = opts.chip ?? "nes";
  const rowsPerBeat = opts.rowsPerBeat ?? DEFAULT_ROWS_PER_BEAT;
  const chords = opts.chords ?? "auto";
  const bad = checkOptions(chip, rowsPerBeat, chords);
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
    chords,
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
    issues.push(...chordIssues(c));
  }
  for (const c of channels) {
    issues.push(...lossIssues(c, meter, setup.chords));
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
