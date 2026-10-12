/* What happens to one channel's notes, instruments and effects when it moves to a channel of another chip: the pitch
   fitted to the new channel's range, the instrument swapped for one of the channel's kind, effects the chip cannot do
   dropped or converted. A Mapper is built per moved channel; mapTrack and mapMml apply it to pattern rows and MML. */

import { CHIPS } from "../chips/index.ts";
import { channelRange, type Range } from "../midi/plan.ts";
import { chooseShift, foldInto } from "../midi/reduce.ts";
import { formatMml, parseMml } from "../mml/index.ts";
import { effectFromByte } from "../normalize/effects.ts";
import type {
  ChannelKind,
  ChipChannel,
  ChipId,
  ChipProfile,
  Effect,
  MmlEvent,
  Row,
  SongChannel,
} from "../types.ts";
import { drumByPitch, drumPitch, sampleDrum } from "./instrument-roles.ts";
import type { ChannelFacts } from "./rechip-facts.ts";
import {
  drumKitInstrument,
  type Registry,
  resolveInstrument,
} from "./rechip-registry.ts";
import type { Role } from "./roles.ts";

/** What the mapping changed, for the report. */
export interface Tally {
  /** Notes moved by octaves one by one to fit the range. */
  folded: number;
  /** Effects removed or converted, by the sentence that says so. */
  fx: Map<string, number>;
  /** Whole octaves the channel was moved to fit the range. */
  shift: number;
}

export interface Mapper {
  /** The instrument the channel plays until a row names another. */
  defaultInst: () => string;
  /** The part is drums. */
  drums: boolean;
  fx: (list: readonly Effect[]) => Effect[];
  /** A drum hit on the new channel: its note, and the instrument that plays it when the channel picks one per hit. */
  hit: (
    note: number,
    source: string | null
  ) => { inst: string | null; note: number };
  inst: (source: string) => string;
  /** Drums on a sample channel: the instrument is picked per hit. */
  perHit: boolean;
  pitch: (note: number) => number;
  range: Range;
  tally: Tally;
}

export interface MapperInit {
  facts: ChannelFacts;
  fromChip: ChipId;
  reg: Registry;
  role: Role;
  to: ChipChannel;
}

/* ---------- effects ---------- */

interface FxContext {
  from: ChipProfile;
  fromKind: ChannelKind;
  to: ChipChannel;
  toChip: ChipId;
  toProfile: ChipProfile;
}

/** The chips whose `filter` effect (E01) switches something: the Amiga's LED filter. */
const LED_FILTER_CHIPS: readonly string[] = ["amiga"];

/** The result of one effect: kept (possibly changed), or removed with the sentence that says why. */
type FxResult =
  | { effect: Effect; why: string | null }
  | { effect: null; why: string };

const keep = (effect: Effect): FxResult => ({ effect, why: null });
const remove = (why: string): FxResult => ({ effect: null, why });

function pulseDuty(e: Effect, c: FxContext): FxResult {
  if (c.to.fixedDuty !== undefined) {
    return remove(`duty (V) effects removed (the duty of ${c.to.id} is fixed)`);
  }
  const toList = c.toProfile.constraints.dutyCycles;
  if (toList.length === 0) {
    return keep(e);
  }
  const value = e.x * 16 + e.y;
  const duty = c.from.constraints.dutyCycles[value];
  if (duty === undefined) {
    return value < toList.length
      ? keep(e)
      : remove(
          `duty (V) values beyond the ${toList.length} duties of ${c.toChip} removed`
        );
  }
  let nearest = 0;
  for (const [i, d] of toList.entries()) {
    if (Math.abs(d - duty) < Math.abs((toList[nearest] ?? 0) - duty)) {
      nearest = i;
    }
  }
  if (nearest === value) {
    return keep(e);
  }
  return {
    effect: effectFromByte("duty", nearest),
    why: `duty (V) values changed to the nearest duty of ${c.toChip}`,
  };
}

function convertDuty(e: Effect, c: FxContext): FxResult {
  if (c.fromKind !== c.to.kind) {
    return remove(
      `duty (V) effects removed (they mean something else on a ${c.to.kind} channel)`
    );
  }
  if (c.to.kind === "pulse") {
    return pulseDuty(e, c);
  }
  if (c.to.kind === "fm") {
    const max = c.to.fmOps === 2 ? 1 : 7;
    return e.x * 16 + e.y > max
      ? remove(`FM algorithm (V) values above ${max} removed`)
      : keep(e);
  }
  return c.to.kind === "wave" || c.to.kind === "sid"
    ? keep(e)
    : remove(`duty (V) effects removed (${c.to.kind} channels have no duty)`);
}

function convertEffect(e: Effect, c: FxContext): FxResult {
  const k = c.toProfile.constraints;
  switch (e.type) {
    case "duty":
      return convertDuty(e, c);
    case "pan":
      return k.pan === "free" || k.pan === "hard"
        ? keep(e)
        : remove(`pan effects removed (${c.toChip} has no free pan)`);
    case "send":
      return k.masterFx
        ? keep(e)
        : remove(`send effects removed (${c.toChip} has no echo or reverb)`);
    case "filter":
      return LED_FILTER_CHIPS.includes(c.toChip)
        ? keep(e)
        : remove(`filter (E) effects removed (${c.toChip} has no LED filter)`);
    case "sampleOffset":
      return c.to.kind === "sample"
        ? keep(e)
        : remove(`sample offset effects removed (${c.to.id} plays no samples)`);
    default:
      return keep(e);
  }
}

/* ---------- the mapper ---------- */

export function createMapper(init: MapperInit): Mapper {
  const { facts, fromChip, reg, role, to } = init;
  const drums = role === "drums";
  const range = channelRange(reg.chip, to.id, to.kind);
  const tally: Tally = {
    folded: 0,
    fx: new Map(),
    shift: drums ? 0 : chooseShift(facts.notes, range),
  };
  const fxContext: FxContext = {
    from: CHIPS[fromChip],
    fromKind: facts.channel.kind,
    to,
    toChip: reg.chip,
    toProfile: CHIPS[reg.chip],
  };
  const perHit = drums && to.kind === "sample";
  const instCache = new Map<string, string>();
  const resolve = (source: string): string =>
    perHit
      ? drumKitInstrument(
          reg,
          sampleDrum(reg.all[source]) ?? "kick",
          to,
          source
        )
      : resolveInstrument(reg, source, role, to);
  const inst = (source: string): string => {
    let id = instCache.get(source);
    if (id === undefined) {
      id = resolve(source);
      instCache.set(source, id);
    }
    return id;
  };
  return {
    defaultInst: () =>
      perHit
        ? drumKitInstrument(reg, "kick", to, null)
        : resolveInstrument(reg, null, role, to),
    drums,
    fx: (list) => {
      const out: Effect[] = [];
      for (const e of list) {
        const r = convertEffect(e, fxContext);
        if (r.effect) {
          out.push({ ...r.effect });
        }
        if (r.why) {
          tally.fx.set(r.why, (tally.fx.get(r.why) ?? 0) + 1);
        }
      }
      return out;
    },
    hit: (note, source) => {
      const played = source === null ? undefined : reg.all[source];
      const generator = sampleDrum(played);
      if (perHit) {
        return {
          inst: drumKitInstrument(
            reg,
            generator ?? drumByPitch(note),
            to,
            source
          ),
          note,
        };
      }
      return {
        inst: null,
        note: generator === null ? note : drumPitch(generator),
      };
    },
    inst,
    perHit,
    pitch: (note) => {
      const moved = note + tally.shift * 12;
      const fitted = foldInto(moved, range);
      if (fitted !== moved) {
        tally.folded += 1;
      }
      return fitted;
    },
    range,
    tally,
  };
}

/* ---------- applying it ---------- */

/** Pattern rows on the new channel. `start` is the instrument the source channel plays until a row names another. */
export function mapTrack(
  rows: readonly Row[],
  m: Mapper,
  start: string | null
): Row[] {
  let source = start;
  let played: string | null = null;
  return rows.map((row) => {
    source = row.inst ?? source;
    const out: Row = {
      fx: m.fx(row.fx),
      inst: row.inst === null ? null : m.inst(row.inst),
      note: row.note,
      row: row.row,
      vol: row.vol,
    };
    if (typeof row.note !== "number") {
      return out;
    }
    if (!m.drums) {
      out.note = m.pitch(row.note);
      return out;
    }
    const hit = m.hit(row.note, source);
    out.note = hit.note;
    if (m.perHit) {
      out.inst = hit.inst === played ? null : hit.inst;
      played = hit.inst;
    }
    return out;
  });
}

function mapEvent(e: MmlEvent, channel: SongChannel, m: Mapper): MmlEvent {
  if (e.type === "inst") {
    return { ...e, id: m.inst(e.id) };
  }
  if (e.type !== "note") {
    return e;
  }
  const own = e.inst === null ? null : m.inst(e.inst);
  if (!m.drums) {
    return { ...e, fx: m.fx(e.fx), inst: own, note: m.pitch(e.note) };
  }
  const hit = m.hit(e.note, e.inst ?? channel.instrument);
  return {
    ...e,
    fx: m.fx(e.fx),
    inst: m.perHit ? hit.inst : own,
    note: hit.note,
  };
}

/**
 * MML on the new channel. The text is only written again when something in it changes (a note, an instrument, an
 * effect); written again it is the same music with repeats played out. MML with errors is kept as it is.
 */
export function mapMml(text: string, channel: SongChannel, m: Mapper): string {
  const parsed = parseMml(text);
  if (parsed.issues.some((i) => i.severity === "error")) {
    return text;
  }
  const events = parsed.events.map((e) => mapEvent(e, channel, m));
  if (JSON.stringify(events) === JSON.stringify(parsed.events)) {
    return text;
  }
  const body = formatMml(events);
  return parsed.tempo === null ? body : `t${parsed.tempo} ${body}`;
}
