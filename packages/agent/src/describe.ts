// Plain-text descriptions of songs and instruments (and the facts behind the song one), shared by the CLI's `describe`
// and `new` commands and the assistant's tools. An sfx has its own in @bleepkit/sfx (`describeSfx`).
import {
  type Instrument,
  noteName,
  PPQ,
  parseMml,
  type Song,
} from "@bleepkit/core";

const round = (value: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/** "0.42s", "12.5s", "1m03.2s". */
export function fmtSeconds(seconds: number): string {
  if (seconds < 10) {
    return `${seconds.toFixed(2)}s`;
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const m = Math.floor(seconds / 60);
  return `${m}m${(seconds - m * 60).toFixed(1).padStart(4, "0")}s`;
}

export interface ChannelFacts {
  high: string | null;
  id: string;
  instrument: string | null;
  kind: string;
  low: string | null;
  muted: boolean;
  notes: number;
  source: "mml" | "pattern" | "empty";
}

export interface SongFacts {
  approxSeconds: number;
  bars: number;
  channels: ChannelFacts[];
  chip: string;
  loopFromSeconds: number | null;
  loopOrder: number | null;
  orderLength: number;
  patterns: number;
  rowsPerBeat: number;
  tempo: number;
}

function range(notes: number[]): { high: string | null; low: string | null } {
  if (notes.length === 0) {
    return { high: null, low: null };
  }
  return {
    high: noteName(Math.max(...notes)),
    low: noteName(Math.min(...notes)),
  };
}

/** What one channel plays: its note numbers, where they came from and, for MML, how long it runs. */
interface ChannelScan {
  mmlLoopPulse: number | null;
  mmlPulses: number;
  notes: number[];
  source: ChannelFacts["source"];
}

function scanMmlChannel(mml: string): ChannelScan {
  const notes: number[] = [];
  let mmlPulses = 0;
  const parsed = parseMml(mml);
  for (const e of parsed.events) {
    if (e.type === "note") {
      notes.push(e.note);
    }
    if (e.type === "note" || e.type === "rest") {
      mmlPulses = Math.max(mmlPulses, e.pulse + e.duration);
    }
  }
  return { mmlLoopPulse: parsed.loopPulse, mmlPulses, notes, source: "mml" };
}

function scanPatternChannel(song: Song, channelId: string): ChannelScan {
  const notes: number[] = [];
  for (const id of song.order) {
    for (const row of song.patterns[id]?.tracks[channelId] ?? []) {
      if (typeof row.note === "number") {
        notes.push(row.note);
      }
    }
  }
  return {
    mmlLoopPulse: null,
    mmlPulses: 0,
    notes,
    source: notes.length > 0 ? "pattern" : "empty",
  };
}

export function songFacts(song: Song): SongFacts {
  const secondsPerRow = 60 / song.tempo / song.rowsPerBeat;
  let patternRows = 0;
  let loopRows: number | null = null;
  song.order.forEach((id, i) => {
    if (i === song.loop) {
      loopRows = patternRows;
    }
    patternRows += song.patterns[id]?.length ?? 0;
  });
  let mmlPulses = 0;
  let mmlLoopPulse: number | null = null;
  const channels: ChannelFacts[] = song.channels.map((c) => {
    const scan = c.mml ? scanMmlChannel(c.mml) : scanPatternChannel(song, c.id);
    mmlPulses = Math.max(mmlPulses, scan.mmlPulses);
    mmlLoopPulse ??= scan.mmlLoopPulse;
    return {
      ...range(scan.notes),
      id: c.id,
      instrument: c.instrument,
      kind: c.kind,
      muted: c.muted,
      notes: scan.notes.length,
      source: scan.source,
    };
  });
  const mmlSeconds = (mmlPulses / PPQ) * (60 / song.tempo);
  const approxSeconds = Math.max(patternRows * secondsPerRow, mmlSeconds);
  let loopFromSeconds: number | null = null;
  if (loopRows !== null) {
    loopFromSeconds = loopRows * secondsPerRow;
  } else if (mmlLoopPulse !== null) {
    loopFromSeconds = (mmlLoopPulse / PPQ) * (60 / song.tempo);
  }
  return {
    approxSeconds: round(approxSeconds, 2),
    bars: round(((approxSeconds / 60) * song.tempo) / 4, 1),
    channels,
    chip: song.chip,
    loopFromSeconds:
      loopFromSeconds === null ? null : round(loopFromSeconds, 2),
    loopOrder: song.loop,
    orderLength: song.order.length,
    patterns: Object.keys(song.patterns).length,
    rowsPerBeat: song.rowsPerBeat,
    tempo: song.tempo,
  };
}

export function describeSong(song: Song): string {
  const f = songFacts(song);
  const parts = [
    `${song.name}: ${song.chip} song, ${f.tempo} BPM, ${f.rowsPerBeat} rows per beat.`,
    f.approxSeconds > 0
      ? `About ${fmtSeconds(f.approxSeconds)} (${f.bars} bars at 4/4)${
          f.loopFromSeconds === null
            ? ", plays once."
            : `, loops back to ${fmtSeconds(f.loopFromSeconds)}.`
        }`
      : "No notes yet.",
  ];
  const lines = f.channels.map((c) => {
    const what =
      c.source === "empty"
        ? "empty"
        : `${c.notes} notes${c.low ? ` ${c.low}..${c.high}` : ""} from ${c.source}`;
    return `  ${c.id} (${c.kind}${c.instrument ? `, @${c.instrument}` : ", no instrument"}${c.muted ? ", muted" : ""}): ${what}`;
  });
  return `${parts.join(" ")}\nChannels:\n${lines.join("\n")}`;
}

export function describeInstrument(inst: Instrument): string {
  const e = inst.envelope;
  const bits = [
    `${inst.name}: ${inst.kind} instrument${inst.chip ? ` for ${inst.chip}` : " (any chip)"}, volume ${inst.volume}.`,
    `Envelope attack ${e.attack}s, decay ${e.decay}s, sustain ${e.sustain}, release ${e.release}s.`,
  ];
  if (inst.pulse) {
    bits.push(`Pulse duty ${inst.pulse.duty}.`);
  }
  if (inst.noise) {
    bits.push(`Noise mode ${inst.noise.mode}.`);
  }
  if (inst.fm) {
    bits.push(
      `FM algorithm ${inst.fm.algorithm}, ${inst.fm.ops.length} operators, feedback ${inst.fm.feedback}.`
    );
  }
  if (inst.sid) {
    bits.push(
      `SID waveforms ${inst.sid.waveforms.join("+")}, filter ${inst.sid.filter.mode}.`
    );
  }
  if (inst.sample) {
    bits.push(`Sample generator ${inst.sample.generator}.`);
  }
  const macros = Object.entries(inst.macros)
    .filter(([, m]) => typeof m === "object" && m !== null && "values" in m)
    .map(([k, m]) => `${k}(${(m as { values: number[] }).values.length})`);
  if (macros.length > 0) {
    bits.push(`Macros: ${macros.join(", ")}.`);
  }
  return bits.join(" ");
}
