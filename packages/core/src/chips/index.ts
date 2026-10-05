import type {
  ChipChannel,
  ChipId,
  ChipProfile,
  SfxWave,
  Song,
} from "../types.ts";
import { ADLIB } from "./adlib.ts";
import { C64 } from "./c64.ts";
import { CUSTOM } from "./custom.ts";
import { GAMEBOY } from "./gameboy.ts";
import { GENESIS } from "./genesis.ts";
import { NES } from "./nes.ts";
import { SNES } from "./snes.ts";

export const CHIPS: Readonly<Record<ChipId, ChipProfile>> = {
  adlib: ADLIB,
  c64: C64,
  custom: CUSTOM,
  gameboy: GAMEBOY,
  genesis: GENESIS,
  nes: NES,
  snes: SNES,
};

export function chipProfile(id: ChipId): ChipProfile {
  return CHIPS[id];
}

/** The channels a song runs on: the profile's channels (in profile order, so a channel index is stable per chip),
    or the song's own declared channels for "custom". */
export function chipChannels(
  song: Pick<Song, "chip" | "channels">
): readonly ChipChannel[] {
  if (song.chip !== "custom") {
    return CHIPS[song.chip].channels;
  }
  return song.channels.map((c) => ({ id: c.id, kind: c.kind, label: c.id }));
}

const ALL_WAVES: readonly SfxWave[] = [
  "square",
  "triangle",
  "saw",
  "sine",
  "noise",
  "wave",
  "fm",
];

/** Sfx waves a chip allows (section 2.4). The first entry is the fallback for a disallowed wave. */
export const CHIP_SFX_WAVES: Readonly<Record<ChipId, readonly SfxWave[]>> = {
  adlib: ["fm", "square", "sine", "saw"],
  c64: ["square", "saw", "triangle", "noise"],
  custom: ALL_WAVES,
  gameboy: ["square", "wave", "noise"],
  genesis: ["square", "noise", "fm"],
  nes: ["square", "triangle", "noise"],
  snes: ["sine", "triangle", "saw", "square", "noise"],
};

export function chipSfxWaves(id: ChipId): readonly SfxWave[] {
  return CHIP_SFX_WAVES[id];
}
