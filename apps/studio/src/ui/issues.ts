/* Normalize issues, spoken plainly: the path becomes a field name, errors are red, warnings amber. */
import type { Issue } from "../lib/contract.ts";
import { h } from "../lib/dom.ts";

const DIGITS_ONLY = /^\d+$/;

/* Labels as the inspector shows them, by JSON pointer with array indexes written as "#". Anything not listed falls back
   to its key split into words, so a path the table does not know still reads as plain language. */
const LABELS: Record<string, string> = {
  "/arpeggio": "Arpeggio",
  "/arpeggio/rate": "Arpeggio / Rate (Hz)",
  "/arpeggio/steps": "Arpeggio / Steps",
  "/bitcrush": "Crush",
  "/bitcrush/bits": "Crush / Bits",
  "/bitcrush/rateDivide": "Crush / Rate divide",
  "/category": "Category",
  "/channels": "Channels",
  "/channels/#": "Channel",
  "/channels/#/id": "Channel / Id",
  "/channels/#/instrument": "Channel / Instrument",
  "/channels/#/kind": "Channel / Kind",
  "/channels/#/mml": "Channel / MML",
  "/channels/#/muted": "Channel / Mute",
  "/channels/#/pan": "Channel / Pan",
  "/channels/#/volume": "Channel / Volume",
  "/chip": "Chip",
  "/duty": "Duty",
  "/duty/start": "Duty / Pulse width",
  "/duty/sweep": "Duty / Sweep",
  "/envelope": "Envelope",
  "/envelope/attack": "Envelope / Attack",
  "/envelope/decay": "Envelope / Decay",
  "/envelope/punch": "Envelope / Punch",
  "/envelope/sustain": "Envelope / Sustain",
  "/export": "Export",
  "/filter": "Filter",
  "/filter/highpass": "Filter / Highpass (Hz)",
  "/filter/highpassSweep": "Filter / Highpass sweep",
  "/filter/lowpass": "Filter / Lowpass (Hz)",
  "/filter/lowpassSweep": "Filter / Lowpass sweep",
  "/filter/resonance": "Filter / Resonance",
  "/finetune": "Finetune",
  "/fm": "FM patch",
  "/fm/algorithm": "FM patch / Algorithm",
  "/fm/feedback": "FM patch / Feedback",
  "/fm/index": "FM patch / Index",
  "/fm/indexDecay": "FM patch / Index decay",
  "/fm/lfo": "FM patch / LFO",
  "/fm/lfo/ampDepth": "FM patch / LFO amp depth",
  "/fm/lfo/pitchDepth": "FM patch / LFO pitch depth",
  "/fm/lfo/rate": "FM patch / LFO rate (Hz)",
  "/fm/ops": "FM patch / Operators",
  "/fm/ops/#": "FM patch / Operator",
  "/fm/ratio": "FM patch / Ratio",
  "/frequency": "Frequency",
  "/frequency/deltaSlide": "Frequency / Delta slide",
  "/frequency/min": "Frequency / Cut-off (Hz)",
  "/frequency/slide": "Frequency / Slide",
  "/frequency/start": "Frequency / Start (Hz)",
  "/kind": "Kind",
  "/loop": "Loop to order",
  "/macros": "Macros",
  "/master": "Master",
  "/master/echo": "Master / Echo",
  "/master/reverb": "Master / Reverb",
  "/master/volume": "Master / Volume",
  "/name": "Name",
  "/noise": "Noise",
  "/noise/mode": "Noise mode",
  "/order": "Order",
  "/order/#": "Order entry",
  "/pan": "Pan",
  "/patterns": "Patterns",
  "/phaser": "Phaser",
  "/phaser/offset": "Phaser / Offset (ms)",
  "/phaser/sweep": "Phaser / Sweep (ms/s)",
  "/pulse": "Pulse",
  "/pulse/duty": "Pulse / Duty",
  "/repeat": "Repeat",
  "/repeat/rate": "Repeat / Rate (Hz)",
  "/rowsPerBeat": "Rows per beat",
  "/sample": "Sample",
  "/sample/baseNote": "Sample / Base note",
  "/sample/generator": "Sample / Generator",
  "/sample/loop": "Sample / Loop",
  "/sample/params": "Sample / Parameters",
  "/sample/seed": "Sample / Seed",
  "/sampleRate": "Sample rate",
  "/seed": "Seed",
  "/send": "Sends",
  "/send/echo": "Sends / Echo",
  "/send/reverb": "Sends / Reverb",
  "/sid": "SID",
  "/sid/filter": "SID / Filter",
  "/sid/pulseWidth": "SID / Pulse width",
  "/sid/pwmDepth": "SID / PWM depth",
  "/sid/pwmRate": "SID / PWM rate (Hz)",
  "/sid/ring": "SID / Ring mod",
  "/sid/sync": "SID / Sync",
  "/sid/waveforms": "SID / Waveforms",
  "/table": "Wave table",
  "/tempo": "Tempo",
  "/tickRate": "Tick rate",
  "/transpose": "Transpose",
  "/version": "Version",
  "/vibrato": "Vibrato",
  "/vibrato/depth": "Vibrato / Depth",
  "/vibrato/rate": "Vibrato / Rate (Hz)",
  "/volume": "Volume",
  "/wave": "Wave",
};

function words(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Split a JSON pointer ("/ops/1/level", RFC 6901 escapes) or a legacy dotted path ("ops[1].level") into keys. */
function pathParts(path: string): string[] {
  if (path.startsWith("/")) {
    return path
      .slice(1)
      .split("/")
      .map((k) => k.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
}

const isIdx = (k: string) => DIGITS_ONLY.test(k);
const tail = (k: string) => (isIdx(k) ? `Item ${Number(k) + 1}` : words(k));
/** Nouns in LABELS that stand for an array entry, so "Channel" plus index 2 reads "Channel 3". */
const INDEXED_NOUNS = ["Channel", "Operator", "Order entry"];

/** Pattern ids are user chosen, so a pattern path is described segment by segment. */
function patternLabel(parts: string[]): string {
  const [, id, what, track, row, field] = parts;
  const out = [`Pattern ${id}`];
  if (what === "length") {
    out.push("Length");
  } else if (what === "tracks" && track !== undefined) {
    out.push(track);
    if (row !== undefined) {
      out.push(`Row ${row}`);
    }
    if (field !== undefined) {
      out.push(field === "fx" ? "Effect" : words(field));
    }
  } else if (what !== undefined) {
    out.push(words(what));
  }
  return out.join(" / ");
}

/** The LABELS entry for a path prefix, with the array indexes of the prefix written into it (1 based). */
function knownLabel(prefix: string[]): string | undefined {
  const known = LABELS[`/${prefix.map((k) => (isIdx(k) ? "#" : k)).join("/")}`];
  if (known === undefined) {
    return undefined;
  }
  const idx = prefix.filter(isIdx).map((k) => Number(k) + 1);
  let label = known;
  for (const noun of INDEXED_NOUNS) {
    const at = idx.length > 0 ? label.indexOf(noun) : -1;
    if (at >= 0) {
      label = `${label.slice(0, at + noun.length)} ${idx.shift()}${label.slice(at + noun.length)}`;
    }
  }
  return label;
}

/** The field name for an issue path: "/frequency/start" is "Frequency / Start (Hz)", "/loop" is "Loop to order",
 * "/channels/2/mml" is "Channel 3 / MML", "/patterns/verse/tracks/noise/4" is "Pattern verse / noise / Row 4". */
export function fieldLabel(path: string): string {
  const parts = pathParts(path);
  if (parts.length === 0) {
    return "Whole document";
  }
  if (parts[0] === "patterns" && parts.length > 1) {
    return patternLabel(parts);
  }
  // the longest known prefix names the field, what is left over is appended as words
  for (let n = parts.length; n >= 1; n -= 1) {
    const label = knownLabel(parts.slice(0, n));
    if (label !== undefined) {
      return [label, ...parts.slice(n).map(tail)].join(" / ");
    }
  }
  return parts.map(tail).join(" / ");
}

/** Put the issues box, or nothing, into an inspector's issue slot. */
export function showIssues(
  slot: Element | null,
  issues: readonly Issue[]
): void {
  if (!slot) {
    return;
  }
  slot.replaceChildren();
  const box = issuesBox(issues);
  if (box) {
    slot.append(box);
  }
}

export function issuesBox(issues: readonly Issue[]): HTMLElement | null {
  if (issues.length === 0) {
    return null;
  }
  const errors = issues.some((i) => i.severity === "error");
  const box = h("div", {
    class: `issues${errors ? "" : " warn"}`,
    role: "status",
  });
  for (const i of issues.slice(0, 8)) {
    const row = h("div", {});
    row.append(
      h("span", { class: "path" }, fieldLabel(i.path)),
      ` ${i.message}`
    );
    box.append(row);
  }
  if (issues.length > 8) {
    box.append(h("div", {}, `and ${issues.length - 8} more`));
  }
  return box;
}
