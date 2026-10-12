// Starter documents: the per-chip starter set written by `init`. The instrument presets and the song templates
// (`new instrument`, `new song`) are shared with the assistant and live in @bleepkit/agent.
import {
  bassKind,
  type ChannelKind,
  type ChipId,
  type Instrument,
  makeInstrument,
} from "@bleepkit/core";

/** lead and drums instrument kinds per chip; the bass kind is the chip's bass voice (init writes the three). */
const STARTER_KINDS: Record<ChipId, [ChannelKind, ChannelKind]> = {
  adlib: ["fm", "fm"],
  amiga: ["sample", "sample"],
  c64: ["sid", "sid"],
  custom: ["pulse", "noise"],
  gameboy: ["pulse", "noise"],
  genesis: ["fm", "noise"],
  nes: ["pulse", "noise"],
  snes: ["sample", "sample"],
};

export function starterInstruments(
  chip: ChipId
): { id: string; instrument: Instrument }[] {
  const [lead, drums] = STARTER_KINDS[chip];
  return [
    { id: "lead", instrument: makeInstrument(lead, chip, "lead", "Lead") },
    {
      id: "bass",
      instrument: makeInstrument(bassKind(chip), chip, "bass", "Bass"),
    },
    { id: "drums", instrument: makeInstrument(drums, chip, "drums", "Drums") },
  ];
}
