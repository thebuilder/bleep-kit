// Normalize a document the way the application does and store it only when it is valid: the one door every writing
// tool goes through, so nothing the model produces can reach the project unchecked.
import {
  channelRole,
  findMisfits,
  fittingInstruments,
  type Instrument,
  type InstrumentMisfit,
  type Issue,
  issuesToText,
  mmlToPatterns,
  type Normalized,
  normalizeInstrument,
  normalizeSfx,
  normalizeSong,
  PRESET_FOR_ROLE,
  type Song,
} from "@bleepkit/core";
import {
  type AgentHost,
  type AnyDoc,
  type DocKind,
  type DocRef,
  refText,
} from "../host.ts";
import { done, fail, type ToolOutput } from "../tool-kit.ts";

const MAX_ISSUE_LINES = 14;

async function normalizeFor(
  host: AgentHost,
  kind: DocKind,
  json: unknown,
  extra: Record<string, Instrument>
): Promise<Normalized<AnyDoc>> {
  if (kind === "sfx") {
    return normalizeSfx(json);
  }
  if (kind === "instrument") {
    return normalizeInstrument(json);
  }
  return normalizeSong(json, { ...(await host.instruments()), ...extra });
}

const misfitKey = (m: InstrumentMisfit): string =>
  `${m.channel}:${m.id}:${m.reason}`;

const REASON_TEXT = {
  chip: (inst: Instrument | undefined, chip: string) =>
    `was made for the ${inst?.chip ?? "another"} chip, this song is for ${chip}`,
  kind: (inst: Instrument | undefined) =>
    `is a ${inst?.kind ?? "different"} instrument, the channel needs another kind`,
  operators: () => "has the wrong number of FM operators for the channel",
} as const;

/**
 * A song may only play instruments that fit their channel (made for the song's chip or for none, of the channel's kind).
 * Refuses a song that plays a misfit it did not play before, with the instruments that do fit each channel, or how to
 * make one from the per-chip presets. Misfits an older version of the song already had are left for the person.
 */
async function misfitRefusal(
  host: AgentHost,
  ref: DocRef,
  song: Song,
  extra: Record<string, Instrument>
): Promise<ToolOutput | null> {
  const instruments = { ...(await host.instruments()), ...extra };
  const found = findMisfits(song, instruments);
  if (found.length === 0) {
    return null;
  }
  const before = (await host.read(ref)) as Song | null;
  const had = new Set(
    before ? findMisfits(before, instruments).map(misfitKey) : []
  );
  const fresh = found.filter((m) => !had.has(misfitKey(m)));
  if (fresh.length === 0) {
    return null;
  }
  const lines = fresh.map((m) => {
    const channel = song.channels.find((c) => c.id === m.channel);
    if (!channel) {
      return `- ${m.channel}: "${m.id}" does not fit`;
    }
    const inst = instruments[m.id];
    const fits = fittingInstruments(instruments, channel, song.chip);
    const role = channelRole(song.chip, channel);
    const make = `new_instrument {"id":"${song.chip}-${role}","chip":"${song.chip}","kind":"${channel.kind}","preset":"${PRESET_FOR_ROLE[role]}"}`;
    const why = REASON_TEXT[m.reason](inst, song.chip);
    return fits.length > 0
      ? `- ${m.channel} (${channel.kind}): "${m.id}" ${why}. Instruments that fit it: ${fits.slice(0, 8).join(", ")}.`
      : `- ${m.channel} (${channel.kind}): "${m.id}" ${why}, and no instrument of the project fits it. Make one: ${make}`;
  });
  const name = refText(ref);
  return fail(
    `Refused ${name}: instruments for the wrong chip`,
    `Refused: ${name} plays instruments that do not fit their channels, nothing was saved.\n${lines.join("\n")}\nUse an instrument that fits (a channel's "instrument", a row's "inst" or @id in the MML) and call again.`
  );
}

/** Issues as lines for the model, errors first, at most `MAX_ISSUE_LINES`. */
function issueLines(issues: readonly Issue[]): string {
  const ordered = [
    ...issues.filter((i) => i.severity === "error"),
    ...issues.filter((i) => i.severity === "warning"),
  ];
  const lines = issuesToText(ordered.slice(0, MAX_ISSUE_LINES));
  const more = ordered.length - MAX_ISSUE_LINES;
  return more > 0 ? `${lines}\n... and ${more} more` : lines;
}

/** What a failed song needs most when the project has no instruments to point its channels at. */
async function instrumentHint(host: AgentHost, kind: DocKind): Promise<string> {
  if (kind !== "song") {
    return "";
  }
  const count = Object.keys(await host.instruments()).length;
  return count === 0
    ? "\nThe project has no instruments yet: create some with new_instrument (a lead, a bass, drums) before the song."
    : "";
}

const KEPT_HELP =
  "A channel that stays MML text still plays, but its cells in the grid are read only. Take the jump, skip or halt effects out of the patterns, or keep the tune to 256 bars, to have it as rows.";

/** What the conversion to patterns had to say: channels that stay MML (with how to fix it), then the rest. */
function keptText(notes: readonly Issue[]): string {
  const kept = notes.filter((i) => i.message.includes("stays as MML text"));
  const rest = notes.filter((i) => !kept.includes(i));
  return [
    kept.length > 0 ? `\n${issueLines(kept)}\n${KEPT_HELP}` : "",
    rest.length > 0 ? `\n${issueLines(rest)}` : "",
  ].join("");
}

export interface CommitOptions {
  /** Refuse when the document exists (a `new_*` tool must not overwrite by accident). */
  create?: boolean;
  /** Check everything and report, but store nothing (the value is returned when the document is good). */
  dryRun?: boolean;
  /** Instruments the song may use that the project does not have yet (the caller writes them after this check). */
  extraInstruments?: Record<string, Instrument>;
  /** The sentence that names what happened, in front of the result: "Created" or "Updated". */
  verb?: string;
}

/** Validate and store. Returns the outcome for the model and the person, plus the normalized value on success. */
export async function commit(
  host: AgentHost,
  ref: DocRef,
  json: unknown,
  opts: CommitOptions = {}
): Promise<{ out: ToolOutput; value: AnyDoc | null }> {
  const name = refText(ref);
  if (opts.create && (await host.read(ref))) {
    return {
      out: fail(
        `${name} already exists`,
        `${name} already exists, nothing was changed. Pick another id, or use write_document / edit_document to change it.`
      ),
      value: null,
    };
  }
  const extra = opts.extraInstruments ?? {};
  const n = await normalizeFor(host, ref.kind, json, extra);
  if (!n.ok) {
    const errors = n.issues.filter((i) => i.severity === "error").length;
    return {
      out: fail(
        `Refused ${name}: ${errors} error${errors === 1 ? "" : "s"}`,
        `Refused: ${name} is not a valid ${ref.kind}, nothing was saved.\n${issueLines(n.issues)}\nFix these and call again.${await instrumentHint(host, ref.kind)}`
      ),
      value: null,
    };
  }
  let value: AnyDoc = n.value;
  let notes: Issue[] = [];
  if (ref.kind === "song") {
    const refused = await misfitRefusal(host, ref, n.value as Song, extra);
    if (refused) {
      return { out: refused, value: null };
    }
    // MML is how the assistant writes, patterns are what a song is stored as (architecture.md section 2.7)
    const converted = mmlToPatterns(n.value as Song);
    value = converted.song;
    notes = converted.issues;
  }
  if (opts.dryRun) {
    return {
      out: done(`Checked ${name}`, `${name} is valid.${keptText(notes)}`),
      value,
    };
  }
  const { created } = await host.write(ref, value);
  const warnings = n.issues.filter((i) => i.severity === "warning");
  const verb = opts.verb ?? (created ? "Created" : "Updated");
  const adjusted =
    warnings.length > 0
      ? `\nThese values were adjusted to fit (check they are what you meant):\n${issueLines(warnings)}`
      : "";
  return {
    out: done(
      `${verb} ${name}`,
      `${verb} ${name}.${adjusted}${keptText(notes)}\nIt is saved in the project and visible in the studio now.`
    ),
    value,
  };
}
