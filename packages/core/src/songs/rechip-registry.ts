/* The instruments of a rechip: which one a moved part plays on its new channel. The project's own instruments come
   first (the one the part already played when its kind fits, then one of the right kind and role), and only when none
   fits is a new one built from the per-chip presets. The project's instruments are never changed. */

import { buildRoleInstrument, drumInstrument } from "../midi/instruments.ts";
import type { ChipChannel, ChipId, Instrument } from "../types.ts";
import {
  type DrumGenerator,
  drumVoiceOf,
  isDrumInstrument,
  roleHint,
  sampleDrum,
} from "./instrument-roles.ts";
import type { Role } from "./roles.ts";

export interface Registry {
  /** The project's instruments plus the ones made so far. */
  all: Record<string, Instrument>;
  chip: ChipId;
  /** Ids made so far, in order. */
  created: string[];
}

export function createRegistry(
  instruments: Record<string, Instrument>,
  chip: ChipId
): Registry {
  return { all: { ...instruments }, chip, created: [] };
}

/** An FM patch must have the operators the channel has, or the song warns about it. */
function fits(inst: Instrument, channel: ChipChannel): boolean {
  if (inst.kind !== channel.kind) {
    return false;
  }
  return !(
    inst.fm &&
    channel.fmOps !== undefined &&
    inst.fm.ops.length !== channel.fmOps
  );
}

/** The role a kind plays without anyone saying so: a triangle is a bass, a noise channel is drums. */
function naturalRole(kind: Instrument["kind"]): Role | null {
  if (kind === "triangle") {
    return "bass";
  }
  return kind === "noise" ? "drums" : null;
}

/** How well an existing instrument plays a role on a channel, 0 for not at all: the role it says, then the chip it was made for. */
function candidateScore(
  reg: Registry,
  id: string,
  inst: Instrument,
  role: Role,
  channel: ChipChannel
): number {
  if (
    !fits(inst, channel) ||
    isDrumInstrument(id, inst) !== (role === "drums")
  ) {
    return 0;
  }
  const hint = roleHint(id, inst.name) ?? naturalRole(inst.kind);
  if (hint !== role) {
    return 0;
  }
  let chipScore = 1;
  if (inst.chip === reg.chip) {
    chipScore = 3;
  } else if (inst.chip === null) {
    chipScore = 2;
  }
  return chipScore;
}

function freeId(reg: Registry, base: string, suffix: string): string {
  for (const candidate of [base, `${base}-${suffix}`]) {
    if (!(candidate in reg.all)) {
      return candidate;
    }
  }
  let n = 2;
  while (`${base}-${suffix}-${n}` in reg.all) {
    n += 1;
  }
  return `${base}-${suffix}-${n}`;
}

function register(reg: Registry, id: string, inst: Instrument): string {
  reg.all[id] = inst;
  reg.created.push(id);
  return id;
}

function bestExisting(
  reg: Registry,
  pick: (id: string, inst: Instrument) => number
): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const id of Object.keys(reg.all).sort()) {
    const inst = reg.all[id];
    const score = inst ? pick(id, inst) : 0;
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** An instrument of the role for the channel's kind: a project instrument that says it is one, else a new preset. */
function ofRole(reg: Registry, role: Role, channel: ChipChannel): string {
  const found = bestExisting(reg, (id, inst) =>
    candidateScore(reg, id, inst, role, channel)
  );
  if (found) {
    return found;
  }
  const made = buildRoleInstrument(reg.chip, channel.kind, role);
  made.name = `${capitalized(role)} for ${reg.chip}`;
  return register(reg, freeId(reg, `${reg.chip}-${role}`, channel.kind), made);
}

/**
 * The instrument a part plays on its new channel. The one it played stays when its kind fits the channel; otherwise a
 * project instrument of the channel's kind that is made for the role; otherwise a new one.
 */
export function resolveInstrument(
  reg: Registry,
  source: string | null,
  role: Role,
  channel: ChipChannel
): string {
  const inst = source === null ? undefined : reg.all[source];
  if (source !== null && inst && fits(inst, channel)) {
    return source;
  }
  return ofRole(reg, role, channel);
}

/** The drum sample instrument for one drum on a sample channel: the one the part played, a project drum, or a new one. */
export function drumKitInstrument(
  reg: Registry,
  generator: DrumGenerator,
  channel: ChipChannel,
  source: string | null
): string {
  const played = source === null ? undefined : reg.all[source];
  if (source !== null && played && sampleDrum(played) === generator) {
    return source;
  }
  const found = bestExisting(reg, (id, inst) =>
    fits(inst, channel) && sampleDrum(inst) === generator
      ? candidateScore(reg, id, inst, "drums", channel) || 1
      : 0
  );
  if (found) {
    return found;
  }
  const { instrument } = drumInstrument(
    reg.chip,
    channel,
    drumVoiceOf(generator)
  );
  instrument.name = `${capitalized(generator)} for ${reg.chip}`;
  return register(
    reg,
    freeId(reg, `${reg.chip}-${generator}`, channel.kind),
    instrument
  );
}
