/* The instruments an imported song needs, built from the shared presets. Ids are `midi-<chip>-<role>` so an import never
   clobbers the project's own instruments, and importing a second song for the same chip reuses the same ones. */

import { chipProfile } from "../chips/index.ts";
import { makeInstrument } from "../presets.ts";
import type { ChannelKind, ChipChannel, ChipId, Instrument } from "../types.ts";
import { type ChipPlan, type DrumVoice, PLANS } from "./plan.ts";

export type Role = "lead" | "harmony" | "bass" | "drums";

export interface Built {
  id: string;
  instrument: Instrument;
}

type PlannedChip = keyof typeof PLANS;

/**
 * The role of a channel under the chip's plan: the first melodic channel leads, the rest harmonize. The drum channel
 * of a chip that can also play melody (a SID or FM voice) harmonizes when the file has no drums.
 */
export function roleOf(
  plan: ChipPlan,
  channelId: string,
  drumsUsed: boolean
): Role {
  if (channelId === plan.bass) {
    return "bass";
  }
  if (channelId === plan.drums) {
    return drumsUsed ? "drums" : "harmony";
  }
  return plan.melodic[0] === channelId ? "lead" : "harmony";
}

function kindOfChannel(chip: PlannedChip, id: string): ChannelKind | null {
  return chipProfile(chip).channels.find((c) => c.id === id)?.kind ?? null;
}

/** Instruments of the common kind keep the short id; a channel of another kind (a PSG square among FM voices) adds it. */
function instrumentId(
  chip: PlannedChip,
  role: Role,
  channel: ChipChannel
): string {
  const plan = PLANS[chip];
  const usual =
    role === "harmony"
      ? kindOfChannel(chip, plan.melodic[1] ?? plan.melodic[0] ?? "")
      : null;
  const base = `midi-${chip}-${role}`;
  return usual !== null && usual !== channel.kind
    ? `${base}-${channel.kind}`
    : base;
}

const ROLE_NAMES: Record<Role, string> = {
  bass: "MIDI bass",
  drums: "MIDI drums",
  harmony: "MIDI harmony",
  lead: "MIDI lead",
};

const PRESET_OF_ROLE = {
  bass: "bass",
  drums: "drums",
  harmony: "lead",
  lead: "lead",
} as const;

function shapeHarmony(inst: Instrument): void {
  if (inst.pulse) {
    inst.pulse = { duty: 0.25 };
  }
  if (inst.sample) {
    inst.sample = { ...inst.sample, generator: "pluck", loop: false };
  }
}

/** The instrument a role plays on a channel (drums on the sample chip: see `drumInstrument`). */
export function roleInstrument(
  chip: ChipId,
  channel: ChipChannel,
  role: Role
): Built {
  const id = instrumentId(chip as PlannedChip, role, channel);
  const instrument = makeInstrument(
    channel.kind,
    chip,
    PRESET_OF_ROLE[role],
    ROLE_NAMES[role]
  );
  if (role === "harmony") {
    shapeHarmony(instrument);
  }
  if (role === "drums" && instrument.sid) {
    // a SID voice has no noise channel: it plays the noise waveform, and the note picks the pitch of the hiss
    instrument.sid = { ...instrument.sid, waveforms: ["noise"] };
  }
  return { id, instrument };
}

/** One instrument per drum on a sample chip, so a row can pick the kick, the snare or the hat by instrument. */
export function drumInstrument(
  chip: ChipId,
  channel: ChipChannel,
  voice: DrumVoice
): Built {
  const id = `midi-${chip}-${voice.generator}`;
  const instrument = makeInstrument(
    channel.kind,
    chip,
    "drums",
    `MIDI ${voice.generator}`
  );
  if (instrument.sample) {
    instrument.sample = { ...instrument.sample, generator: voice.generator };
  }
  return { id, instrument };
}
