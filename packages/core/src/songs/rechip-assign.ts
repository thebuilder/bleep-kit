/* Which channel of the new chip plays which channel of the song. Every channel with notes gets a role (drums, bass,
   lead, harmony), the roles pick the channels whose kind suits them best, and what finds no channel is left over. The
   suitability table is about channel kinds only, so a chip added later works without a change here. */

import type { ChannelKind, ChipChannel } from "../types.ts";
import type { ChannelFacts } from "./rechip-facts.ts";
import { partScore, pickBass, type Role } from "./roles.ts";

/** A channel of the song with the role it plays. */
export interface Part {
  facts: ChannelFacts;
  role: Role;
}

/**
 * How well a channel kind plays a role, 0 meaning not at all. Drums want noise, then a sample, FM or SID voice; the bass
 * wants the triangle or wave channel, then FM, sample or SID; melody wants pulse, FM, SID or a sample, and can use the
 * wave or triangle channel when nothing else is left.
 */
const FIT: Record<Role, Partial<Record<ChannelKind, number>>> = {
  bass: { fm: 8, pulse: 3, sample: 7, sid: 6, triangle: 10, wave: 9 },
  drums: { fm: 5, noise: 10, sample: 6, sid: 5 },
  harmony: { fm: 9, pulse: 10, sample: 7, sid: 8, triangle: 2, wave: 4 },
  lead: { fm: 9, pulse: 10, sample: 7, sid: 8, triangle: 3, wave: 4 },
};

/** A pulse with a fixed duty (a PSG square) is the smaller voice next to an FM channel. */
const FIXED_DUTY_PENALTY = 1.5;

export function fitOf(role: Role, channel: ChipChannel): number {
  const base = FIT[role][channel.kind] ?? 0;
  const fixed = channel.kind === "pulse" && channel.fixedDuty !== undefined;
  return base > 0 && fixed ? base - FIXED_DUTY_PENALTY : base;
}

function withNotes(facts: readonly ChannelFacts[]): ChannelFacts[] {
  return facts.filter((f) => f.written > 0);
}

/**
 * The roles of the channels that have notes, most important first: the lead, the bass, the drums, then the harmony
 * lines by busyness. Noise and drum instruments are drums; of the rest the lowest busy channel is the bass (when
 * something plays well above it), the busiest high channel the lead, the others harmony.
 */
export function inferParts(facts: readonly ChannelFacts[]): Part[] {
  const active = withNotes(facts);
  const drums = active.filter((f) => f.drums);
  const pitched = active.filter((f) => !f.drums);
  const bass = pickBass(pitched, pitched);
  const rest = pitched
    .filter((f) => f !== bass)
    .sort(
      (a, b) =>
        partScore(b.onsets, b.median) - partScore(a.onsets, a.median) ||
        b.onsets - a.onsets
    );
  const [lead, ...harmony] = rest;
  const parts: Part[] = [];
  if (lead) {
    parts.push({ facts: lead, role: "lead" });
  }
  if (bass) {
    parts.push({ facts: bass, role: "bass" });
  }
  for (const f of [...drums].sort((a, b) => b.onsets - a.onsets)) {
    parts.push({ facts: f, role: "drums" });
  }
  for (const f of harmony) {
    parts.push({ facts: f, role: "harmony" });
  }
  return parts;
}

export interface Assignment {
  /** Parts that found no channel, most important first. */
  overflow: Part[];
  /** Part to the channel of the new chip that plays it. */
  placed: Map<Part, ChipChannel>;
}

/** The free channel that suits the role best: the first of equals, the last for drums (the end of the list is theirs). */
function bestChannel(
  role: Role,
  free: readonly ChipChannel[]
): ChipChannel | null {
  let best: ChipChannel | null = null;
  let bestFit = 0;
  for (const channel of free) {
    const fit = fitOf(role, channel);
    if (fit > bestFit || (fit === bestFit && fit > 0 && role === "drums")) {
      best = channel;
      bestFit = fit;
    }
  }
  return best;
}

export function assignChannels(
  parts: readonly Part[],
  channels: readonly ChipChannel[]
): Assignment {
  const free = [...channels];
  const placed = new Map<Part, ChipChannel>();
  const overflow: Part[] = [];
  for (const part of parts) {
    const channel = bestChannel(part.role, free);
    if (channel) {
      placed.set(part, channel);
      free.splice(free.indexOf(channel), 1);
    } else {
      overflow.push(part);
    }
  }
  return { overflow, placed };
}
