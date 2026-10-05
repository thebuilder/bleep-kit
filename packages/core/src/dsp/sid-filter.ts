/* The SID's one shared multimode filter (section 3.6): cutoff 0..1 maps to 30 Hz..12 kHz on a log scale and
   resonance 0..1 to Q 0.5..8. */

import type { Svf } from "./svf.ts";
import { SVF_BP, SVF_HP, SVF_LP, svfSet } from "./svf.ts";

export const SID_CUTOFF_MIN = 30;
export const SID_CUTOFF_MAX = 12_000;

export function sidCutoffHz(c: number): number {
  const x = Math.min(1, Math.max(0, c));
  return SID_CUTOFF_MIN * (SID_CUTOFF_MAX / SID_CUTOFF_MIN) ** x;
}

export function sidQ(resonance: number): number {
  return 0.5 + Math.min(1, Math.max(0, resonance)) * 7.5;
}

export function sidFilterMode(mode: "off" | "lp" | "bp" | "hp"): number {
  switch (mode) {
    case "lp":
      return SVF_LP;
    case "bp":
      return SVF_BP;
    case "hp":
      return SVF_HP;
    default:
      return 0;
  }
}

export function setSidFilter(
  s: Svf,
  cutoff: number,
  resonance: number,
  mode: number,
  sampleRate: number
): void {
  svfSet(s, sidCutoffHz(cutoff), sidQ(resonance), mode, sampleRate);
}
