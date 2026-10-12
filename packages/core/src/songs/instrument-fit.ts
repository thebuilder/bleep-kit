/* Which instruments a song may use on which channel: the instrument's chip is the song's chip or null (any chip), its
   kind is the channel's kind, and an FM patch has the operators the channel has. This is what normalizeSong warns about
   ("designed for chip ..."). The judging lives here, the swapping in instrument-fix.ts. Pure. */

import { chipProfile } from "../chips/index.ts";
import type { ChipChannel, ChipId, Instrument, SongChannel } from "../types.ts";

/** An instrument made for another chip: the chip a song names is the only one it may be played on (null is any). */
export function chipFits(inst: Instrument, chip: ChipId): boolean {
  return chip === "custom" || inst.chip === null || inst.chip === chip;
}

/** The chip's own channel for a song channel (its FM operator count matters), or a stand-in made from the song's. */
export function hardwareChannel(
  chip: ChipId,
  channel: SongChannel
): ChipChannel {
  const known = chipProfile(chip).channels.find((c) => c.id === channel.id);
  return known ?? ({ id: channel.id, kind: channel.kind } as ChipChannel);
}

/** True when the instrument can play on the channel: chip, kind and (for FM) operator count. */
export function instrumentFits(
  inst: Instrument,
  channel: Pick<ChipChannel, "fmOps" | "kind">,
  chip: ChipId
): boolean {
  if (chip === "custom") {
    return true;
  }
  if (!chipFits(inst, chip) || inst.kind !== channel.kind) {
    return false;
  }
  return !(
    inst.fm &&
    channel.fmOps !== undefined &&
    inst.fm.ops.length !== channel.fmOps
  );
}

/** The ids of the instruments that fit a channel, sorted: those made for the chip first, then the chip-less ones. */
export function fittingInstruments(
  instruments: Readonly<Record<string, Instrument>>,
  channel: Pick<SongChannel, "id" | "kind">,
  chip: ChipId
): string[] {
  const hardware = hardwareChannel(chip, channel as SongChannel);
  const fit = Object.keys(instruments)
    .sort()
    .filter((id) => {
      const inst = instruments[id];
      return inst !== undefined && instrumentFits(inst, hardware, chip);
    });
  const rank = (id: string): number => (instruments[id]?.chip === chip ? 0 : 1);
  return fit.sort((a, b) => rank(a) - rank(b));
}

/** Why an instrument does not fit a channel, or null when it does. */
export function misfitReason(
  inst: Instrument,
  channel: Pick<ChipChannel, "fmOps" | "kind">,
  chip: ChipId
): "chip" | "kind" | "operators" | null {
  if (chip === "custom") {
    return null;
  }
  if (!chipFits(inst, chip)) {
    return "chip";
  }
  if (inst.kind !== channel.kind) {
    return "kind";
  }
  return inst.fm &&
    channel.fmOps !== undefined &&
    inst.fm.ops.length !== channel.fmOps
    ? "operators"
    : null;
}
