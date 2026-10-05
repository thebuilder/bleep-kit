// Compact human rendering of an Analysis object: a few lines of numbers and a 60 column ASCII envelope.

import type { Analysis } from "@bleepkit/core/tools";
import { fmtDb, fmtSeconds, round } from "./output.ts";

const RAMP = " .:-=+*#%@";

function asciiEnvelope(
  envelope: { time: number; db: number }[],
  columns = 60,
  floorDb = -60
): string {
  if (envelope.length === 0) {
    return "";
  }
  const top = Math.max(...envelope.map((e) => e.db), floorDb + 1);
  const cols: number[] = new Array(columns).fill(floorDb);
  envelope.forEach((e, i) => {
    const c = Math.min(
      columns - 1,
      Math.floor((i / envelope.length) * columns)
    );
    cols[c] = Math.max(cols[c] ?? floorDb, e.db);
  });
  return cols
    .map((db) => {
      const t = Math.max(0, Math.min(1, (db - floorDb) / (top - floorDb)));
      return RAMP[Math.round(t * (RAMP.length - 1))] ?? " ";
    })
    .join("");
}

export function analysisText(a: Analysis, label?: string): string {
  const lines: string[] = [];
  lines.push(
    `${label ?? a.file}: ${fmtSeconds(a.duration)}, ${a.sampleRate} Hz, ${a.channels} ch`
  );
  lines.push(
    `  level    peak ${fmtDb(a.peakDb)}  rms ${fmtDb(a.rmsDb)}  lufs ${round(a.lufs, 1)}  crest ${fmtDb(a.crestDb)}  dc ${round(a.dcOffset, 4)}`
  );
  lines.push(
    a.clipped.frames > 0
      ? `  CLIPPING ${a.clipped.frames} frames, first at ${a.clipped.first === null ? "?" : fmtSeconds(a.clipped.first / a.sampleRate)}: lower the volume or the master`
      : "  clipping none"
  );
  lines.push(
    `  silence  leading ${fmtSeconds(a.leadingSilence)}, trailing ${fmtSeconds(a.trailingSilence)}, quietest 50 ms ${fmtDb(a.silenceDb)}`
  );
  const p = a.pitch;
  lines.push(
    p.medianHz === null
      ? "  pitch    none detected (noise or too short)"
      : `  pitch    ${p.medianNote ?? "?"} (${round(p.medianHz, 1)} Hz median)`
  );
  const s = a.spectrum;
  lines.push(
    `  spectrum centroid ${Math.round(s.centroidHz)} Hz; low ${fmtDb(s.bands.lowDb)}, mid ${fmtDb(s.bands.midDb)}, high ${fmtDb(s.bands.highDb)}`
  );
  if (a.dutyCycle !== null) {
    lines.push(`  duty     ${round(a.dutyCycle * 100, 1)}%`);
  }
  if (a.loop) {
    lines.push(
      `  loop     ${fmtSeconds(a.loop.start)} to ${fmtSeconds(a.loop.end)}, seam difference ${fmtDb(a.loop.seamDiffDb)}`
    );
  }
  const env = asciiEnvelope(a.envelope);
  if (env) {
    lines.push(`  envelope |${env}|`);
  }
  if (a.images) {
    lines.push(`  images   ${Object.values(a.images).join(", ")}`);
  }
  return lines.join("\n");
}
