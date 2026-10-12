import {
  describeInstrument,
  describeSample,
  describeSong,
  fmtSeconds,
  songFacts,
} from "@bleepkit/agent";
import {
  type Instrument,
  noteName,
  type Sfx,
  type Song,
  type UserSample,
} from "@bleepkit/core";
import { describeSfx } from "@bleepkit/sfx";
import { CliError, fmtDb, round } from "../output.ts";
import {
  type DocKind,
  loadDoc,
  openProject,
  type ProjectCtx,
  resolveRef,
} from "../project.ts";
import { freshness, readMeta } from "../render.ts";
import type { CommandSpec } from "./types.ts";

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
  if (kind === "sample") {
    const sample = doc.value as UserSample;
    return {
      description: describeSample(sample),
      facts: {
        baseNote: sample.baseNote,
        bits: sample.bits,
        loop: sample.loop,
        rate: sample.rate,
        volume: sample.volume,
      },
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
    "instrument the envelope and patch; for a user sample its format, length, base note, loop and peak. Also reports the last render's duration and level, and whether it is stale.",
  examples: [
    "bleepkit describe sfx/coin",
    "bleepkit describe song/title --json",
    "bleepkit describe sample/kick",
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
    const r = resolveRef(pc, refArg, ["sfx", "song", "instrument", "sample"]);
    const d = describeAny(pc, r.kind, r.id);
    let render: Record<string, unknown> | null = null;
    if (r.kind !== "instrument" && r.kind !== "sample") {
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
      r.kind === "instrument" || r.kind === "sample"
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
    } else if (r.kind !== "instrument" && r.kind !== "sample") {
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
