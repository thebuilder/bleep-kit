import {
  type Instrument,
  noteName,
  PPQ,
  parseMml,
  type Sfx,
  type Song,
} from "@bleepkit/core";
import { describeSfx } from "@bleepkit/sfx";
import { CliError, fmtDb, fmtSeconds, round } from "../output.ts";
import {
  type DocKind,
  loadDoc,
  openProject,
  type ProjectCtx,
  resolveRef,
} from "../project.ts";
import { freshness, readMeta } from "../render.ts";
import type { CommandSpec } from "./types.ts";

interface ChannelFacts {
  high: string | null;
  id: string;
  instrument: string | null;
  kind: string;
  low: string | null;
  muted: boolean;
  notes: number;
  source: "mml" | "pattern" | "empty";
}

interface SongFacts {
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

function songFacts(song: Song): SongFacts {
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

function sfxFacts(sfx: Sfx) {
  const note = Math.round(12 * Math.log2(sfx.frequency.start / 440) + 69);
  return {
    category: sfx.category,
    chip: sfx.chip,
    durationSeconds: round(
      sfx.envelope.attack + sfx.envelope.sustain + sfx.envelope.decay,
      3
    ),
    slideOctavesPerSecond: sfx.frequency.slide,
    startHz: sfx.frequency.start,
    startNote: noteName(note),
    volume: sfx.volume,
    wave: sfx.wave,
  };
}

function describeAny(
  pc: ProjectCtx,
  kind: DocKind,
  id: string
): {
  description: string;
  facts: Record<string, unknown>;
  ok: boolean;
  issues: unknown[];
  rel: string;
} {
  const doc = loadDoc(pc, kind, id);
  if (kind === "sfx") {
    const sfx = doc.value as Sfx;
    return {
      description: describeSfx(sfx),
      facts: sfxFacts(sfx),
      issues: doc.issues,
      ok: doc.ok,
      rel: doc.rel,
    };
  }
  if (kind === "song") {
    const song = doc.value as Song;
    return {
      description: describeSong(song),
      facts: songFacts(song) as unknown as Record<string, unknown>,
      issues: doc.issues,
      ok: doc.ok,
      rel: doc.rel,
    };
  }
  const inst = doc.value as Instrument;
  return {
    description: describeInstrument(inst),
    facts: { chip: inst.chip, kind: inst.kind, volume: inst.volume },
    issues: doc.issues,
    ok: doc.ok,
    rel: doc.rel,
  };
}

export const describeCommand: CommandSpec = {
  description:
    "Explains a document in words, plus the facts an agent needs without listening: for an sfx the wave, start pitch, " +
    "length and category; for a song the tempo, length, loop point and per-channel note counts and range; for an " +
    "instrument the envelope and patch. Also reports the last render's duration and level, and whether it is stale.",
  examples: [
    "bleepkit describe sfx/coin",
    "bleepkit describe song/title --json",
  ],
  flags: [],
  name: "describe",
  run: (ctx, args) => {
    const [refArg] = args.positionals;
    if (!refArg) {
      throw new CliError("usage", "describe needs a document reference", {
        hint: "Example: bleepkit describe sfx/coin  (run `bleepkit list` to see what exists)",
      });
    }
    const pc = openProject(ctx);
    const r = resolveRef(pc, refArg, ["sfx", "song", "instrument"]);
    const d = describeAny(pc, r.kind, r.id);
    let render: Record<string, unknown> | null = null;
    if (r.kind !== "instrument") {
      const meta = readMeta(pc, r.kind, r.id);
      if (meta) {
        render = {
          clipped: meta.clipped,
          duration: meta.duration,
          loopEnd: meta.loopEnd,
          loopStart: meta.loopStart,
          peakDb: meta.peakDb,
          rmsDb: meta.rmsDb,
          stale: freshness(pc, r.kind, r.id) !== "fresh",
        };
      }
    }
    const next: string[] =
      r.kind === "instrument"
        ? [`bleepkit validate ${r.ref}`]
        : [
            `bleepkit render ${r.ref} --analyze`,
            `bleepkit validate ${r.ref}`,
            r.kind === "sfx"
              ? `bleepkit mutate ${r.ref} --count 4`
              : "bleepkit export --dry-run",
          ];
    const lines = [d.description];
    if (render) {
      lines.push(
        `Last render: ${fmtSeconds(render.duration as number)}, peak ${fmtDb(render.peakDb as number)}, rms ${fmtDb(render.rmsDb as number)}${render.clipped ? ", CLIPPED" : ""}${render.stale ? " (stale: the document changed since)" : ""}.`
      );
    } else if (r.kind !== "instrument") {
      lines.push(`Not rendered yet. Try: bleepkit render ${r.ref} --analyze`);
    }
    const problems = (
      d.issues as { severity: string; path: string; message: string }[]
    ).map((i) => `  ${i.severity} ${i.path || "/"}: ${i.message}`);
    if (problems.length > 0) {
      lines.push("Issues:", ...problems);
    }
    lines.push(`File: ${d.rel}`, `Next: ${next.join("  |  ")}`);
    return {
      human: lines.join("\n"),
      json: {
        description: d.description,
        facts: d.facts,
        issues: d.issues,
        kind: r.kind,
        next,
        ok: true,
        path: d.rel,
        ref: r.ref,
        render,
        valid: d.ok,
      },
    };
  },
  summary: "explain an sfx, song or instrument in words and numbers",
  usage: "describe <ref>",
};
