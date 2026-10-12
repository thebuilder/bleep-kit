/* Finding and fixing the instruments a song plays on channels they do not fit (the wrong chip, the wrong kind, the wrong
   number of FM operators): the studio's "Use a <chip> instrument" button, the assistant's tools and the importers all go
   through here. See architecture.md section 2.9 (Instruments). Pure: nothing it is given is changed. */

import { PLANS } from "../midi/plan.ts";
import type { ChipId, Instrument, Row, Song, SongChannel } from "../types.ts";
import {
  fittingInstruments,
  hardwareChannel,
  misfitReason,
} from "./instrument-fit.ts";
import { roleHint } from "./instrument-roles.ts";
import { createRegistry, resolveInstrument } from "./rechip-registry.ts";
import type { Role } from "./roles.ts";

const MML_INSTRUMENT = /@([A-Za-z0-9-]+)/g;

/** The instrument ids an MML text switches to with @id (comments after ";" do not count). */
export function mmlInstrumentIds(mml: string): string[] {
  const ids: string[] = [];
  for (const line of mml.split("\n")) {
    const code = line.split(";", 1)[0] ?? "";
    for (const m of code.matchAll(MML_INSTRUMENT)) {
      ids.push(m[1] ?? "");
    }
  }
  return ids;
}

/** `@from` switches in an MML text rewritten to `@to`, comments left alone. */
function renameInMml(mml: string, from: string, to: string): string {
  return mml
    .split("\n")
    .map((line) => {
      const at = line.indexOf(";");
      const code = at < 0 ? line : line.slice(0, at);
      const rest = at < 0 ? "" : line.slice(at);
      return (
        code.replace(MML_INSTRUMENT, (all, id: string) =>
          id === from ? `@${to}` : all
        ) + rest
      );
    })
    .join("\n");
}

function rowsOf(song: Song, channelId: string): Row[] {
  return Object.values(song.patterns).flatMap((p) => p.tracks[channelId] ?? []);
}

/** Every instrument id a channel plays: its own, the ones its rows name, the ones its MML switches to. */
export function channelInstrumentIds(
  song: Song,
  channel: SongChannel
): string[] {
  const ids = new Set<string>();
  if (channel.instrument !== null) {
    ids.add(channel.instrument);
  }
  if (channel.mml === null) {
    for (const row of rowsOf(song, channel.id)) {
      if (row.inst !== null) {
        ids.add(row.inst);
      }
    }
  } else {
    for (const id of mmlInstrumentIds(channel.mml)) {
      ids.add(id);
    }
  }
  return [...ids];
}

/** One use of an instrument on a channel it does not fit. */
export interface InstrumentMisfit {
  channel: string;
  id: string;
  reason: "chip" | "kind" | "operators";
}

/** Every instrument a channel of the song plays that does not fit it (instruments that do not exist are not misfits). */
export function findMisfits(
  song: Song,
  instruments: Readonly<Record<string, Instrument>>
): InstrumentMisfit[] {
  const out: InstrumentMisfit[] = [];
  for (const channel of song.channels) {
    const hardware = hardwareChannel(song.chip, channel);
    for (const id of channelInstrumentIds(song, channel)) {
      const inst = instruments[id];
      const reason = inst ? misfitReason(inst, hardware, song.chip) : null;
      if (reason) {
        out.push({ channel: channel.id, id, reason });
      }
    }
  }
  return out;
}

/** What a channel is for on its chip: the bass voice, the drums, the lead (first melodic channel) or harmony. */
export function channelRole(
  chip: ChipId,
  channel: Pick<SongChannel, "id" | "kind">
): Role {
  if (channel.kind === "noise") {
    return "drums";
  }
  if (channel.kind === "triangle") {
    return "bass";
  }
  const plan = chip === "custom" ? undefined : PLANS[chip];
  if (plan?.bass === channel.id) {
    return "bass";
  }
  if (plan?.drums === channel.id) {
    return "drums";
  }
  return plan && plan.melodic[0] !== channel.id ? "harmony" : "lead";
}

/** The role a channel plays in a swap: what the instrument's own name says, else what the channel is for on its chip. */
function roleFor(
  song: Song,
  channel: SongChannel,
  id: string,
  inst: Instrument
): Role {
  return roleHint(id, inst.name) ?? channelRole(song.chip, channel);
}

/** One instrument swapped on one channel. */
export interface InstrumentSwap {
  channel: string;
  /** True when `to` was made from the per-chip presets for this fix. */
  created: boolean;
  from: string;
  to: string;
}

export interface FixResult {
  /** The ids of the instruments that were made (a subset of the keys of `instruments`). */
  created: string[];
  /** The instruments the song needs: the ones given, untouched, plus the ones made. */
  instruments: Record<string, Instrument>;
  /** The song with the misfits swapped (the same content when there were none). */
  song: Song;
  swaps: InstrumentSwap[];
}

function swapIn(song: Song, channel: SongChannel, from: string, to: string) {
  if (channel.instrument === from) {
    channel.instrument = to;
  }
  if (channel.mml === null) {
    for (const row of rowsOf(song, channel.id)) {
      if (row.inst === from) {
        row.inst = to;
      }
    }
  } else {
    channel.mml = renameInMml(channel.mml, from, to);
  }
}

/**
 * Swap every instrument the song plays on a channel it does not fit for one that does: an instrument of the project
 * made for the chip (or for any chip) of the right kind and role, else a new one from the per-chip presets
 * (`makeInstrument`), named `<chip>-<role>`. `only` limits the fix to those instrument ids (the warning's button fixes
 * the one the warning names). Existing instruments are never changed or deleted.
 */
export function fixMisfits(
  song: Song,
  instruments: Readonly<Record<string, Instrument>>,
  only?: ReadonlySet<string>
): FixResult {
  const out = JSON.parse(JSON.stringify(song)) as Song;
  const reg = createRegistry({ ...instruments }, song.chip);
  const swaps: InstrumentSwap[] = [];
  for (const channel of out.channels) {
    const hardware = hardwareChannel(out.chip, channel);
    for (const id of channelInstrumentIds(song, channel)) {
      const inst = instruments[id];
      if (
        !inst ||
        (only && !only.has(id)) ||
        misfitReason(inst, hardware, out.chip) === null
      ) {
        continue;
      }
      const before = reg.created.length;
      const to = resolveInstrument(
        reg,
        id,
        roleFor(out, channel, id, inst),
        hardware
      );
      swapIn(out, channel, id, to);
      swaps.push({
        channel: channel.id,
        created: reg.created.length > before,
        from: id,
        to,
      });
    }
  }
  return { created: reg.created, instruments: reg.all, song: out, swaps };
}

/** The preset a role starts from (`makeInstrument`): harmony is a lead played softer. */
export const PRESET_FOR_ROLE = {
  bass: "bass",
  drums: "drums",
  harmony: "lead",
  lead: "lead",
} as const;

/**
 * An instrument for a channel that has none: a project instrument that fits it and says it is for the channel's role
 * (the chip's own first); else, with `any`, any project instrument that fits; else, with `create`, a new one from the
 * per-chip presets named `<chip>-<role>`. Null when none of that is allowed or possible.
 */
export function instrumentForChannel(
  chip: ChipId,
  channel: Pick<SongChannel, "id" | "kind">,
  instruments: Readonly<Record<string, Instrument>>,
  opts: { any?: boolean; create?: boolean } = {}
): { created: Record<string, Instrument>; id: string | null } {
  const role = channelRole(chip, channel);
  const fits = fittingInstruments(instruments, channel, chip);
  const named = fits.find((fitId) => {
    const inst = instruments[fitId];
    return inst ? (roleHint(fitId, inst.name) ?? null) === role : false;
  });
  if (named !== undefined) {
    return { created: {}, id: named };
  }
  if (opts.any && fits[0] !== undefined) {
    return { created: {}, id: fits[0] };
  }
  if (!opts.create) {
    return { created: {}, id: null };
  }
  const reg = createRegistry({ ...instruments }, chip);
  const id = resolveInstrument(
    reg,
    null,
    role,
    hardwareChannel(chip, channel as SongChannel)
  );
  return {
    created: Object.fromEntries(
      reg.created.map((made) => [made, reg.all[made] as Instrument])
    ),
    id,
  };
}
