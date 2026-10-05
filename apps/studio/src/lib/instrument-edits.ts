/* Edits an instrument's own rules ask for, kept apart from the editor that applies them. */
import type { ChipId, Instrument } from "./contract.ts";
import { chipProfile, defaultInstrument } from "./core.ts";

type SidWave = NonNullable<Instrument["sid"]>["waveforms"][number];

/** Turn a SID waveform on or off; one has to stay on. */
export function toggleSidWave(x: Instrument, w: SidWave): void {
  if (!x.sid) {
    return;
  }
  const has = x.sid.waveforms.includes(w);
  if (has && x.sid.waveforms.length === 1) {
    return;
  }
  x.sid.waveforms = has
    ? x.sid.waveforms.filter((v) => v !== w)
    : [...x.sid.waveforms, w];
}

/** A chip with two-operator FM cuts a four-operator patch down to two, a four-operator chip fills it back up. */
export function fitFmOps(x: Instrument, chip: ChipId | null): void {
  if (!(x.kind === "fm" && x.fm && chip)) {
    return;
  }
  const want = chipProfile(chip).channels.find((c) => c.kind === "fm")?.fmOps;
  if (!want || x.fm.ops.length === want) {
    return;
  }
  if (want === 2) {
    x.fm.ops = x.fm.ops.slice(0, 2);
    x.fm.algorithm = Math.min(x.fm.algorithm, 1);
  } else {
    const extra = defaultInstrument("fm", chip).fm?.ops ?? [];
    x.fm.ops = [...x.fm.ops, ...extra.slice(x.fm.ops.length, 4)];
  }
}
