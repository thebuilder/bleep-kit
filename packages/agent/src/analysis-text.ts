// The numbers of an analysis as a short block of text for the model, with the checks from AGENTS.md applied so it does
// not have to remember the targets: songs around -14 to -16 LUFS, sfx peaks between -6 and -16 dBFS, no clipped frames,
// a loop seam below -40 dB.
import { hzToNote, noteName } from "@bleepkit/core";
import type { Analysis } from "@bleepkit/core/tools";
import type { DocKind } from "./host.ts";
import { db } from "./tool-kit.ts";

const ENVELOPE_POINTS = 16;
const SFX_PEAK_LOUD = -6;
const SFX_PEAK_QUIET = -16;
const SONG_LUFS_LOUD = -14;
const SONG_LUFS_QUIET = -16;
const SEAM_CLEAN = -40;

const noteOf = (hz: number): string => noteName(Math.round(hzToNote(hz)));

function envelopeLine(a: Analysis): string {
  const env = a.envelope;
  if (env.length === 0) {
    return "";
  }
  const step = Math.max(1, Math.ceil(env.length / ENVELOPE_POINTS));
  const picks = env.filter((_, i) => i % step === 0);
  const every = (picks[1]?.time ?? 0) - (picks[0]?.time ?? 0);
  return `envelope (RMS dBFS, one value every ${every.toFixed(2)} s): ${picks.map((p) => Math.round(p.db)).join(" ")}`;
}

function pitchLine(a: Analysis): string {
  const confident = a.pitch.track.filter(
    (p) => p.hz !== null && p.confidence >= 0.6
  );
  if (a.pitch.medianHz === null || confident.length === 0) {
    return "pitch: none detected (noise, or too short or too polyphonic to track)";
  }
  const first = confident[0]?.hz ?? 0;
  const last = confident.at(-1)?.hz ?? 0;
  const glide =
    Math.abs(12 * Math.log2(last / first)) >= 1
      ? `; moves from ${noteOf(first)} (${first.toFixed(0)} Hz) to ${noteOf(last)} (${last.toFixed(0)} Hz)`
      : "";
  return `pitch: median ${a.pitch.medianNote ?? noteOf(a.pitch.medianHz)} (${a.pitch.medianHz.toFixed(1)} Hz)${glide}`;
}

/** The checks against the targets, one line each, worded as advice. */
export function checks(a: Analysis, kind: DocKind): string[] {
  const out: string[] = [];
  if (a.clipped.frames > 0) {
    out.push(
      `CLIPPING: ${a.clipped.frames} frames reach full scale. Lower the volume (sfx volume, instrument or channel volume, or the master).`
    );
  } else {
    out.push("no clipping: ok");
  }
  if (kind === "sfx") {
    if (a.peakDb > SFX_PEAK_LOUD) {
      out.push(
        `peak ${db(a.peakDb)} dBFS is louder than the -6 dBFS ceiling for sfx: lower "volume" by about ${(a.peakDb - SFX_PEAK_LOUD).toFixed(0)} dB.`
      );
    } else if (a.peakDb < SFX_PEAK_QUIET) {
      out.push(
        `peak ${db(a.peakDb)} dBFS is quieter than -16 dBFS: raise "volume" by about ${(SFX_PEAK_QUIET - a.peakDb).toFixed(0)} dB.`
      );
    } else {
      out.push("peak is inside the sfx target (-6 to -16 dBFS): ok");
    }
    if (a.leadingSilence > 0.02) {
      out.push(
        `${a.leadingSilence.toFixed(2)} s of silence at the start: a game would hear a delay.`
      );
    }
  }
  if (kind === "song") {
    if (a.lufs > SONG_LUFS_LOUD) {
      out.push(
        `${db(a.lufs)} LUFS is louder than the -14 target for songs: lower the song master or channel volumes by about ${(a.lufs - SONG_LUFS_LOUD).toFixed(1)} dB.`
      );
    } else if (a.lufs < SONG_LUFS_QUIET - 1) {
      out.push(
        `${db(a.lufs)} LUFS is quieter than the -16 target for songs: raise volumes by about ${(SONG_LUFS_QUIET - a.lufs).toFixed(1)} dB.`
      );
    } else {
      out.push("loudness is inside the song target (-14 to -16 LUFS): ok");
    }
    if (a.loop === null) {
      out.push(
        'no loop: the song plays once (put an L in the MML or set "loop" if it should repeat).'
      );
    } else if (a.loop.seamDiffDb === null) {
      out.push(
        "loop starts at the very top: nothing to compare, the seam cannot be judged."
      );
    } else if (a.loop.seamDiffDb < SEAM_CLEAN) {
      out.push(`loop seam ${db(a.loop.seamDiffDb)} dB: clean (below -40)`);
    } else {
      out.push(
        `loop seam ${db(a.loop.seamDiffDb)} dB is above -40: the loop will click or jump. Check that notes are not cut at the loop point and the end matches the start.`
      );
    }
  }
  return out;
}

/** The analysis as text, and the headline for the conversation view. */
export function analysisText(
  label: string,
  kind: DocKind,
  a: Analysis
): { summary: string; text: string } {
  const clip =
    a.clipped.frames > 0
      ? `CLIPPING ${a.clipped.frames} frames`
      : "no clipping";
  const headline =
    kind === "song"
      ? `${db(a.lufs)} LUFS, ${clip}`
      : `peak ${db(a.peakDb)} dBFS, ${a.duration.toFixed(2)} s, ${clip}`;
  const lines = [
    `${label}: ${a.duration.toFixed(2)} s, ${a.sampleRate} Hz`,
    `loudness: peak ${db(a.peakDb)} dBFS, rms ${db(a.rmsDb)} dBFS, ${db(a.lufs)} LUFS, crest ${a.crestDb.toFixed(1)} dB, dc offset ${a.dcOffset.toFixed(3)}`,
    `silence: leading ${a.leadingSilence.toFixed(2)} s, trailing ${a.trailingSilence.toFixed(2)} s, quietest 50 ms window ${db(a.silenceDb)} dBFS`,
    `spectrum: centroid ${a.spectrum.centroidHz.toFixed(0)} Hz; low 20-250 Hz ${db(a.spectrum.bands.lowDb)} dB, mid 250-4000 Hz ${db(a.spectrum.bands.midDb)} dB, high 4000 Hz+ ${db(a.spectrum.bands.highDb)} dB`,
    pitchLine(a),
    a.dutyCycle === null ? "" : `duty cycle: ${a.dutyCycle.toFixed(2)}`,
    a.loop
      ? `loop: ${a.loop.start.toFixed(2)} s to ${a.loop.end.toFixed(2)} s${a.loop.seamDiffDb === null ? "" : `, seam ${db(a.loop.seamDiffDb)} dB`}`
      : "loop: none",
    envelopeLine(a),
    "checks:",
    ...checks(a, kind).map((c) => `- ${c}`),
  ].filter(Boolean);
  return { summary: `Rendered ${label}: ${headline}`, text: lines.join("\n") };
}
