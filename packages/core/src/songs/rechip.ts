/* rechipSong: move a song to another chip without losing it. The old way kept the channels whose id the new chip also
   has, so NES pulse1/pulse2/triangle/noise to Genesis fm1..psgNoise kept nothing. This reads what each channel does
   (drums, bass, lead, harmony), gives it the channel of the new chip that suits that, and moves its patterns and MML
   there with the notes fitted to the channel's range, effects the chip cannot do dropped or converted, and an
   instrument of the right kind. See architecture.md section 2.9. Pure: nothing it is given is changed. */

import { CHIPS, chipChannels } from "../chips/index.ts";
import { parseMml } from "../mml/index.ts";
import type {
  ChipChannel,
  ChipId,
  Effect,
  Instrument,
  Pattern,
  Row,
  Song,
  SongChannel,
} from "../types.ts";
import {
  assignChannels,
  fitOf,
  inferParts,
  type Part,
} from "./rechip-assign.ts";
import { type ChannelFacts, gatherFacts } from "./rechip-facts.ts";
import { createMapper, type Mapper, mapMml, mapTrack } from "./rechip-map.ts";
import { FULL_VOLUME, mergeTracks } from "./rechip-merge.ts";
import { createRegistry, type Registry } from "./rechip-registry.ts";

/** One channel of the song and where it went on the new chip. */
export interface RechipMove {
  from: string;
  /** The role the channel was given and anything notable about how it was placed. */
  note: string;
  to: string;
}

/** A channel (or part of one) that did not make it. */
export interface RechipDrop {
  from: string;
  /** Notes lost, as written in the song. */
  notes: number;
  reason: string;
}

/** Something that was changed to fit the new chip: a note moved by octaves, an effect removed, the echo. */
export interface RechipChange {
  /** The channel of the new chip, or "master". */
  channel: string;
  message: string;
}

export interface RechipResult {
  /** What was changed to fit the chip: notes moved into the range, effects removed or converted. */
  adjusted: RechipChange[];
  /** The ids of the instruments that were made (a subset of the keys of `instruments`). */
  created: string[];
  /** What did not fit on the new chip. */
  dropped: RechipDrop[];
  /** The instruments the song needs: the ones given, untouched, plus the ones made. */
  instruments: Record<string, Instrument>;
  /** Which channel of the song went to which channel of the new chip. */
  moves: RechipMove[];
  song: Song;
}

/** A deep copy: a song is plain JSON, and core has no structuredClone to lean on. */
function cloneSong(song: Song): Song {
  return JSON.parse(JSON.stringify(song)) as Song;
}

/* ---------- the work in progress ---------- */

interface Placed {
  mapper: Mapper;
  part: Part;
  to: ChipChannel;
}

/** A tempo or flow effect found on a line that is not played, to be put on one that is. */
interface Carried {
  fx: Effect[];
  pattern: string;
  row: number;
}

interface Work {
  adjusted: RechipChange[];
  carry: Carried[];
  channels: Map<string, SongChannel>;
  dropped: RechipDrop[];
  fromChip: ChipId;
  moves: RechipMove[];
  placed: Placed[];
  reg: Registry;
  song: Song;
  target: readonly ChipChannel[];
  /** Rows by target channel id, then pattern id. */
  tracks: Map<string, Map<string, readonly Row[]>>;
}

const SONG_FX = new Set<string>(["halt", "jump", "skip", "tempo"]);
const MAX_FX = 4;

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/* ---------- reporting what a mapper did ---------- */

function noteName(note: number): string {
  const names = [
    "C",
    "C#",
    "D",
    "D#",
    "E",
    "F",
    "F#",
    "G",
    "G#",
    "A",
    "A#",
    "B",
  ];
  return `${names[note % 12] ?? "C"}${Math.floor(note / 12) - 1}`;
}

function reportMapper(work: Work, m: Mapper, channel: string): void {
  const { folded, shift, fx } = m.tally;
  const [low, high] = m.range;
  const add = (message: string): void => {
    work.adjusted.push({ channel, message });
  };
  if (shift !== 0) {
    add(
      `moved ${shift > 0 ? "up" : "down"} ${plural(Math.abs(shift), "octave")} to fit the range ${noteName(low)} to ${noteName(high)}`
    );
  }
  if (folded > 0) {
    add(
      `${plural(folded, "note")} moved by octaves into the range ${noteName(low)} to ${noteName(high)}`
    );
  }
  for (const [why, count] of fx) {
    add(`${count} ${why}`);
  }
}

/* ---------- placing a channel ---------- */

const hasPan = (chip: ChipId): boolean =>
  CHIPS[chip].constraints.pan === "free" ||
  CHIPS[chip].constraints.pan === "hard";

function placePart(work: Work, part: Part, to: ChipChannel): void {
  const { channel } = part.facts;
  const mapper = createMapper({
    facts: part.facts,
    fromChip: work.fromChip,
    reg: work.reg,
    role: part.role,
    to,
  });
  const tracks = new Map<string, readonly Row[]>();
  let mml: string | null = null;
  if (channel.mml) {
    mml = mapMml(channel.mml, channel, mapper);
  } else {
    for (const [id, pattern] of Object.entries(work.song.patterns)) {
      const rows = pattern.tracks[channel.id];
      if (rows && rows.length > 0) {
        tracks.set(id, mapTrack(rows, mapper, channel.instrument));
      }
    }
  }
  const instrument = startInstrument(part, mapper);
  work.tracks.set(to.id, tracks);
  work.channels.set(to.id, {
    id: to.id,
    instrument,
    kind: to.kind,
    mml,
    muted: channel.muted,
    pan: hasPan(work.reg.chip) ? channel.pan : 0,
    volume: channel.volume,
  });
  work.placed.push({ mapper, part, to });
  work.moves.push({ from: channel.id, note: part.role, to: to.id });
  reportMapper(work, mapper, to.id);
}

/* ---------- what finds no channel ---------- */

/** Takes tempo and flow effects off the rows of a line that is not played whole, to carry them to a line that is. */
function takeSongFx(work: Work, channel: SongChannel): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const [id, pattern] of Object.entries(work.song.patterns)) {
    const rows = pattern.tracks[channel.id] ?? [];
    const kept = rows.map((r) => {
      const moving = r.fx.filter((e) => SONG_FX.has(e.type));
      if (moving.length > 0) {
        work.carry.push({ fx: moving, pattern: id, row: r.row });
      }
      return { ...r, fx: r.fx.filter((e) => !SONG_FX.has(e.type)) };
    });
    if (kept.length > 0) {
      out.set(id, kept);
    }
  }
  return out;
}

/** The placed line with the most rests that can play the part's kind of line: not drums, not MML. */
function pickHost(work: Work, part: Part): Placed | null {
  let host: Placed | null = null;
  for (const p of work.placed) {
    const mml = work.channels.get(p.to.id)?.mml;
    const free = p.part.role !== "drums" && !mml && fitOf(part.role, p.to) > 0;
    if (
      free &&
      (host === null || p.part.facts.onsets < host.part.facts.onsets)
    ) {
      host = p;
    }
  }
  return host;
}

function drop(work: Work, part: Part, notes: number, reason: string): void {
  work.dropped.push({ from: part.facts.channel.id, notes, reason });
}

/** The instrument a channel plays until a row names another, on the new chip; null when every note names its own. */
function startInstrument(part: Part, mapper: Mapper): string | null {
  const { channel, notes } = part.facts;
  if (channel.instrument !== null) {
    return mapper.inst(channel.instrument);
  }
  return notes.some((n) => n.inst === null) ? mapper.defaultInst() : null;
}

function mergeInto(work: Work, part: Part, host: Placed): void {
  const { channel } = part.facts;
  const mapper = createMapper({
    facts: part.facts,
    fromChip: work.fromChip,
    reg: work.reg,
    role: part.role,
    to: host.to,
  });
  const rows = takeSongFx(work, channel);
  const mapped = new Map<string, readonly Row[]>();
  for (const [id, r] of rows) {
    mapped.set(id, mapTrack(r, mapper, channel.instrument));
  }
  const hostChannel = work.channels.get(host.to.id);
  const lengths: Record<string, number> = {};
  for (const [id, pattern] of Object.entries(work.song.patterns)) {
    lengths[id] = pattern.length;
  }
  const merged = mergeTracks({
    host: work.tracks.get(host.to.id) ?? new Map(),
    hostStart: { inst: hostChannel?.instrument ?? null, vol: FULL_VOLUME },
    lengths,
    order: work.song.order,
    part: mapped,
    partStart: { inst: startInstrument(part, mapper), vol: FULL_VOLUME },
  });
  const where = `the rests of ${host.to.id}`;
  if (merged.fitted === 0) {
    drop(work, part, merged.total, `no room in ${where}`);
    return;
  }
  work.tracks.set(host.to.id, merged.tracks);
  work.moves.push({
    from: channel.id,
    note: `${part.role}, merged into ${where} (${merged.fitted} of ${merged.total} notes fit)`,
    to: host.to.id,
  });
  if (merged.fitted < merged.total) {
    drop(work, part, merged.total - merged.fitted, `no room in ${where}`);
  }
  reportMapper(work, mapper, host.to.id);
}

function handleOverflow(work: Work, part: Part): void {
  const { channel, written } = part.facts;
  const none = `${work.reg.chip} has no free channel for it (${plural(work.target.length, "channel")})`;
  if (channel.mml) {
    drop(
      work,
      part,
      written,
      `${none}, and MML cannot be merged into another channel`
    );
    return;
  }
  const host = part.role === "drums" ? null : pickHost(work, part);
  if (host === null) {
    takeSongFx(work, channel);
    drop(work, part, written, none);
    return;
  }
  mergeInto(work, part, host);
}

/** Puts the carried tempo and flow effects on the first placed line that is not MML. */
function applyCarry(work: Work): void {
  const carrier = work.placed.find((p) => !work.channels.get(p.to.id)?.mml);
  if (!carrier) {
    return;
  }
  const tracks =
    work.tracks.get(carrier.to.id) ?? new Map<string, readonly Row[]>();
  work.tracks.set(carrier.to.id, tracks);
  for (const item of work.carry) {
    const rows = (tracks.get(item.pattern) ?? []).map((r) => ({ ...r }));
    const same = rows.find((r) => r.row === item.row);
    if (same) {
      same.fx = [...same.fx, ...item.fx].slice(0, MAX_FX);
    } else {
      rows.push({
        fx: item.fx,
        inst: null,
        note: null,
        row: item.row,
        vol: null,
      });
      rows.sort((a, b) => a.row - b.row);
    }
    tracks.set(item.pattern, rows);
  }
}

/* ---------- building the result ---------- */

function emptyChannel(tc: ChipChannel): SongChannel {
  return {
    id: tc.id,
    instrument: null,
    kind: tc.kind,
    mml: null,
    muted: false,
    pan: 0,
    volume: 1,
  };
}

function buildPatterns(work: Work): Record<string, Pattern> {
  const out: Record<string, Pattern> = {};
  for (const [id, pattern] of Object.entries(work.song.patterns)) {
    const tracks: Record<string, Row[]> = {};
    for (const [target, perPattern] of work.tracks) {
      const rows = perPattern.get(id);
      if (rows && rows.length > 0) {
        tracks[target] = rows.map((r) => ({ ...r }));
      }
    }
    out[id] = { length: pattern.length, tracks };
  }
  return out;
}

/** Instrument ids the MML of a channel names. */
function mmlInstruments(text: string, used: Set<string>): void {
  for (const e of parseMml(text).events) {
    if (e.type === "inst") {
      used.add(e.id);
    } else if (e.type === "note" && e.inst !== null) {
      used.add(e.inst);
    }
  }
}

/** Instrument ids a song names: channels, pattern rows and MML. */
function usedInstruments(song: Song): Set<string> {
  const used = new Set<string>();
  for (const c of song.channels) {
    if (c.instrument !== null) {
      used.add(c.instrument);
    }
    if (c.mml) {
      mmlInstruments(c.mml, used);
    }
  }
  const rows = Object.values(song.patterns).flatMap((p) =>
    Object.values(p.tracks).flat()
  );
  for (const r of rows) {
    if (r.inst !== null) {
      used.add(r.inst);
    }
  }
  return used;
}

/** Instruments made for a part that in the end found no room are not left behind. */
function pruneCreated(reg: Registry, song: Song): void {
  const used = usedInstruments(song);
  for (const id of [...reg.created]) {
    if (!used.has(id)) {
      delete reg.all[id];
      reg.created.splice(reg.created.indexOf(id), 1);
    }
  }
}

function fitMaster(work: Work, song: Song): void {
  const { master } = song;
  const { chip } = work.reg;
  const note = (message: string): void => {
    work.adjusted.push({ channel: "master", message });
  };
  if (!CHIPS[chip].constraints.masterFx && (master.echo || master.reverb)) {
    const what = [master.echo ? "echo" : "", master.reverb ? "reverb" : ""]
      .filter(Boolean)
      .join(" and ");
    master.echo = null;
    master.reverb = null;
    note(`${what} removed (${chip} has none)`);
  }
  // the Amiga's output stage settings mean nothing on another chip
  const { amiga, ...rest } = master as unknown as Record<string, unknown>;
  if (amiga !== undefined && chip !== "amiga") {
    song.master = rest as unknown as Song["master"];
    note(`Amiga output settings removed (${chip} has no Paula output stage)`);
  }
  // FM 6 as a DAC is a Genesis setting; the new chip's own channels were laid out without it
  const { genesis, ...left } = song.master as unknown as Record<string, unknown>;
  if (genesis !== undefined && chip !== "genesis") {
    song.master = left as unknown as Song["master"];
    note(`Genesis DAC setting removed (${chip} has no FM 6 DAC)`);
  }
}

/** The song as it is, on the other chip, when there is nothing to move: the same chip, or a custom song that keeps its channels. */
function unchanged(
  song: Song,
  instruments: Record<string, Instrument>,
  chip: ChipId
): RechipResult {
  return {
    adjusted: [],
    created: [],
    dropped: [],
    instruments: { ...instruments },
    moves: [],
    song: { ...cloneSong(song), chip },
  };
}

/**
 * The song on another chip. Each channel with notes is given a role from what it is and what it plays, the roles
 * choose the channels of the new chip, and the patterns and MML move there. Where the new chip has fewer channels the
 * least important line is written into the rests of another or dropped, and the result says which. The instruments
 * given are never changed: a moved line plays one of them when one fits, else a new one is made (`created`).
 */
export function rechipSong(
  song: Song,
  instruments: Record<string, Instrument>,
  toChip: ChipId
): RechipResult {
  if (song.chip === toChip || toChip === "custom") {
    return unchanged(song, instruments, toChip);
  }
  const target = chipChannels({ channels: [], chip: toChip });
  const facts: ChannelFacts[] = gatherFacts(song, instruments);
  const { overflow, placed } = assignChannels(inferParts(facts), target);
  const work: Work = {
    adjusted: [],
    carry: [],
    channels: new Map(),
    dropped: [],
    fromChip: song.chip,
    moves: [],
    placed: [],
    reg: createRegistry(instruments, toChip),
    song,
    target,
    tracks: new Map(),
  };
  for (const [part, to] of placed) {
    placePart(work, part, to);
  }
  for (const part of overflow) {
    handleOverflow(work, part);
  }
  applyCarry(work);
  const out = cloneSong(song);
  out.chip = toChip;
  out.channels = target.map(
    (tc) => work.channels.get(tc.id) ?? emptyChannel(tc)
  );
  out.patterns = buildPatterns(work);
  fitMaster(work, out);
  pruneCreated(work.reg, out);
  const order = (id: string): number => target.findIndex((c) => c.id === id);
  return {
    adjusted: work.adjusted,
    created: work.reg.created,
    dropped: work.dropped,
    instruments: work.reg.all,
    moves: work.moves.sort((a, b) => order(a.to) - order(b.to)),
    song: out,
  };
}

/* ---------- words ---------- */

/** The result as sentences, for a confirm dialog, a toast or a tool reply. */
export interface RechipSummary {
  adjusted: string[];
  dropped: string[];
  moved: string[];
}

export function describeRechip(result: RechipResult): RechipSummary {
  return {
    adjusted: result.adjusted.map((a) => `${a.channel}: ${a.message}`),
    dropped: result.dropped.map(
      (d) => `${d.from}: ${plural(d.notes, "note")} dropped (${d.reason})`
    ),
    moved: result.moves.map((m) => `${m.from} to ${m.to} (${m.note})`),
  };
}
