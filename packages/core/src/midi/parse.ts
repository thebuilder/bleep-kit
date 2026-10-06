/* Standard MIDI File parser: formats 0 and 1 (format 2 is read as 1), running status, tempo and time signature metas,
   note on/off with velocity 0 as off. Pure and dependency free; it never throws: problems become issues, and a file it
   cannot read at all comes back with an error issue and no notes. */

import type { Issue } from "../types.ts";

export interface MidiNote {
  /** MIDI channel 0..15 (channel 10 in musician numbering is 9 here). */
  channel: number;
  /** Tick at which the note ends. */
  end: number;
  note: number;
  /** Tick at which the note starts. */
  start: number;
  /** Index of the MTrk chunk the note came from (0 based, file order). */
  track: number;
  /** 1..127. */
  velocity: number;
}

export interface MidiTempo {
  bpm: number;
  tick: number;
}

export interface MidiTimeSignature {
  denominator: number;
  numerator: number;
  tick: number;
}

export interface MidiTrackInfo {
  /** Channels that carry notes in this track, ascending. */
  channels: number[];
  index: number;
  /** The track name meta event, or null. */
  name: string | null;
  noteCount: number;
}

export interface MidiFile {
  /** Tick at which the last event of any track happens. */
  endTick: number;
  format: 0 | 1 | 2;
  issues: Issue[];
  /** Every note of every track, sorted by start tick, then track, channel and pitch. */
  notes: MidiNote[];
  /** Ticks per quarter note (SMPTE time division is converted at 120 BPM). */
  ppq: number;
  tempos: MidiTempo[];
  timeSignatures: MidiTimeSignature[];
  tracks: MidiTrackInfo[];
}

const DEFAULT_PPQ = 96;
const DEFAULT_BPM = 120;
const MICROSECONDS_PER_MINUTE = 60_000_000;
/** Data bytes per channel message status (high nibble): program change and channel pressure take one. */
const DATA_LENGTH: Record<number, number> = {
  128: 2,
  144: 2,
  160: 2,
  176: 2,
  192: 1,
  208: 1,
  224: 2,
};

class Reader {
  readonly bytes: Uint8Array;
  pos: number;

  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes;
    this.pos = pos;
  }

  get left(): number {
    return this.bytes.length - this.pos;
  }

  u8(): number {
    const v = this.bytes[this.pos] ?? 0;
    this.pos += 1;
    return v;
  }

  u16(): number {
    return this.u8() * 256 + this.u8();
  }

  u32(): number {
    return this.u16() * 65_536 + this.u16();
  }

  /** A variable length quantity (at most 4 bytes); null when it runs off the end or is longer than 4 bytes. */
  vlq(): number | null {
    let v = 0;
    for (let i = 0; i < 4; i += 1) {
      if (this.left <= 0) {
        return null;
      }
      const b = this.u8();
      v = v * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) {
        return v;
      }
    }
    return null;
  }

  skip(n: number): void {
    this.pos += n;
  }

  ascii(n: number): string {
    let s = "";
    for (let i = 0; i < n; i += 1) {
      s += String.fromCharCode(this.u8());
    }
    return s;
  }
}

interface Header {
  format: 0 | 1 | 2;
  ppq: number;
  trackCount: number;
}

interface Ctx {
  endTick: number;
  issues: Issue[];
  notes: MidiNote[];
  tempos: MidiTempo[];
  timeSignatures: MidiTimeSignature[];
  tracks: MidiTrackInfo[];
}

function fail(file: Ctx, message: string): void {
  file.issues.push({ message, path: "", severity: "error" });
}

function warn(file: Ctx, message: string): void {
  file.issues.push({ message, path: "", severity: "warning" });
}

/** SMPTE time division (bit 15 set) has no beats: read it as a fixed tempo of 120 BPM, which is what a player does. */
function readDivision(raw: number, file: Ctx): number {
  if (raw === 0) {
    warn(file, `time division is 0, using ${DEFAULT_PPQ} ticks per quarter`);
    return DEFAULT_PPQ;
  }
  if (raw < 0x80_00) {
    return raw;
  }
  const fps = 256 - (raw >> 8);
  const perFrame = raw & 0xff;
  warn(
    file,
    "SMPTE time division has no beats, so it is read as 120 BPM; tempo events are used as written"
  );
  return Math.max(1, Math.round((fps * perFrame) / 2));
}

function readHeader(r: Reader, file: Ctx): Header | null {
  if (r.left < 14 || r.ascii(4) !== "MThd") {
    fail(file, "not a Standard MIDI File (no MThd header)");
    return null;
  }
  const length = r.u32();
  const format = r.u16();
  const trackCount = r.u16();
  const division = r.u16();
  r.skip(Math.max(0, length - 6));
  if (format > 2) {
    fail(file, `unknown MIDI file format ${format}`);
    return null;
  }
  if (format === 2) {
    warn(
      file,
      "format 2 (independent songs) is read as format 1: every track plays at once"
    );
  }
  return {
    format: format as 0 | 1 | 2,
    ppq: readDivision(division, file),
    trackCount,
  };
}

interface Track {
  channels: Set<number>;
  index: number;
  name: string | null;
  noteCount: number;
  /** Open notes by channel and pitch. */
  open: Map<number, MidiNote>;
  tick: number;
}

function closeNote(track: Track, file: Ctx, key: number, tick: number): void {
  const note = track.open.get(key);
  if (!note) {
    return;
  }
  track.open.delete(key);
  note.end = Math.max(tick, note.start);
  file.notes.push(note);
  track.noteCount += 1;
  track.channels.add(note.channel);
}

function noteEvent(
  track: Track,
  file: Ctx,
  on: boolean,
  channel: number,
  data: [number, number]
): void {
  const [pitch, velocity] = data;
  const key = channel * 128 + pitch;
  if (on && velocity > 0) {
    // the same pitch struck again while still held: the first one ends where the second begins
    closeNote(track, file, key, track.tick);
    track.open.set(key, {
      channel,
      end: track.tick,
      note: pitch,
      start: track.tick,
      track: track.index,
      velocity,
    });
    return;
  }
  closeNote(track, file, key, track.tick);
}

function metaEvent(
  r: Reader,
  track: Track,
  file: Ctx,
  type: number,
  length: number
): void {
  const end = r.pos + length;
  if (type === 0x51 && length === 3) {
    const us = r.u8() * 65_536 + r.u16();
    if (us > 0) {
      file.tempos.push({
        bpm: MICROSECONDS_PER_MINUTE / us,
        tick: track.tick,
      });
    }
  } else if (type === 0x58 && length >= 2) {
    // nn dd cc bb: numerator, then the denominator as a power of two
    const numerator = r.u8() || 4;
    file.timeSignatures.push({
      denominator: 2 ** r.u8(),
      numerator,
      tick: track.tick,
    });
  } else if (type === 0x03 && track.name === null) {
    track.name = r.ascii(length).replace(/\0/g, "").trim() || null;
  }
  r.pos = end;
}

interface Status {
  /** The end of track meta event was read: the track ended on purpose. */
  ended: boolean;
  running: number;
}

/** Reads one event; false when the track cannot go on (truncated or malformed). */
function readEvent(
  r: Reader,
  track: Track,
  file: Ctx,
  status: Status,
  limit: number
): boolean {
  const delta = r.vlq();
  if (delta === null || r.pos >= limit) {
    return false;
  }
  track.tick += delta;
  let first = r.u8();
  if (first < 0x80) {
    if (status.running === 0) {
      return false;
    }
    // running status: this byte is already the first data byte
    r.pos -= 1;
    first = status.running;
  }
  if (first === 0xff) {
    const type = r.u8();
    const length = r.vlq();
    if (length === null || r.pos + length > limit) {
      return false;
    }
    if (type === 0x2f) {
      r.pos += length;
      status.ended = true;
      return false;
    }
    metaEvent(r, track, file, type, length);
    return true;
  }
  if (first === 0xf0 || first === 0xf7) {
    const length = r.vlq();
    if (length === null || r.pos + length > limit) {
      return false;
    }
    r.skip(length);
    return true;
  }
  if (first >= 0xf1) {
    return false;
  }
  return channelEvent(r, track, file, status, first, limit);
}

function channelEvent(
  r: Reader,
  track: Track,
  file: Ctx,
  status: Status,
  first: number,
  limit: number
): boolean {
  status.running = first;
  const kind = first & 0xf0;
  const channel = first & 0x0f;
  const count = DATA_LENGTH[kind] ?? 2;
  if (r.pos + count > limit) {
    return false;
  }
  const d1 = r.u8();
  const d2 = count === 2 ? r.u8() : 0;
  if ((d1 | d2) & 0x80) {
    return false;
  }
  if (kind === 0x90 || kind === 0x80) {
    noteEvent(track, file, kind === 0x90, channel, [d1, d2]);
  }
  return true;
}

function readTrack(r: Reader, file: Ctx, index: number, limit: number): void {
  const track: Track = {
    channels: new Set(),
    index,
    name: null,
    noteCount: 0,
    open: new Map(),
    tick: 0,
  };
  const status: Status = { ended: false, running: 0 };
  while (r.pos < limit && readEvent(r, track, file, status, limit)) {
    // events are consumed one at a time until the end of track meta or a malformed byte
  }
  if (!status.ended) {
    warn(
      file,
      `track ${index + 1} is cut short or damaged after tick ${track.tick}, the rest of it was skipped`
    );
  }
  const hanging = track.open.size;
  for (const key of [...track.open.keys()]) {
    closeNote(track, file, key, track.tick);
  }
  if (hanging > 0) {
    warn(
      file,
      `track ${index + 1}: ${hanging} note${hanging === 1 ? " was" : "s were"} never released and end with the track`
    );
  }
  file.endTick = Math.max(file.endTick, track.tick);
  file.tracks.push({
    channels: [...track.channels].sort((a, b) => a - b),
    index,
    name: track.name,
    noteCount: track.noteCount,
  });
}

function sortNotes(notes: MidiNote[]): void {
  notes.sort(
    (a, b) =>
      a.start - b.start ||
      a.track - b.track ||
      a.channel - b.channel ||
      a.note - b.note
  );
}

/** Tempo events sorted by tick; two on one tick keep the last. Always starts with a tempo at tick 0. */
function normalizeTempos(tempos: MidiTempo[]): MidiTempo[] {
  const sorted = tempos
    .map((t, i) => ({ i, t }))
    .sort((a, b) => a.t.tick - b.t.tick || a.i - b.i)
    .map((x) => x.t);
  const out: MidiTempo[] = [];
  for (const t of sorted) {
    const last = out.at(-1);
    if (last && last.tick === t.tick) {
      last.bpm = t.bpm;
    } else {
      out.push({ ...t });
    }
  }
  if (out[0]?.tick !== 0) {
    out.unshift({ bpm: DEFAULT_BPM, tick: 0 });
  }
  return out;
}

export function parseMidi(bytes: Uint8Array): MidiFile {
  const file: Ctx = {
    endTick: 0,
    issues: [],
    notes: [],
    tempos: [],
    timeSignatures: [],
    tracks: [],
  };
  const r = new Reader(bytes);
  const header = readHeader(r, file);
  if (header) {
    readChunks(r, file, header);
  }
  sortNotes(file.notes);
  file.timeSignatures.sort((a, b) => a.tick - b.tick);
  if (header && file.notes.length === 0 && file.issues.length === 0) {
    warn(file, "the file has no notes");
  }
  return {
    endTick: file.endTick,
    format: header?.format ?? 1,
    issues: file.issues,
    notes: file.notes,
    ppq: header?.ppq ?? DEFAULT_PPQ,
    tempos: normalizeTempos(file.tempos),
    timeSignatures: file.timeSignatures,
    tracks: file.tracks.sort((a, b) => a.index - b.index),
  };
}

function readChunks(r: Reader, file: Ctx, header: Header): void {
  let index = 0;
  while (r.left >= 8) {
    const id = r.ascii(4);
    const length = r.u32();
    const limit = Math.min(r.bytes.length, r.pos + length);
    if (id === "MTrk") {
      readTrack(r, file, index, limit);
      index += 1;
    }
    r.pos = limit;
  }
  if (index < header.trackCount) {
    warn(
      file,
      `the header announces ${header.trackCount} tracks but the file holds ${index}`
    );
  }
  if (index === 0) {
    fail(file, "the file has no tracks");
  }
}
