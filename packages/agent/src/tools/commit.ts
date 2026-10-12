// Normalize a document the way the application does and store it only when it is valid: the one door every writing
// tool goes through, so nothing the model produces can reach the project unchecked.
import {
  type Issue,
  issuesToText,
  type Normalized,
  normalizeInstrument,
  normalizeSfx,
  normalizeSong,
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
  json: unknown
): Promise<Normalized<AnyDoc>> {
  if (kind === "sfx") {
    return normalizeSfx(json);
  }
  if (kind === "instrument") {
    return normalizeInstrument(json);
  }
  return normalizeSong(json, await host.instruments());
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

export interface CommitOptions {
  /** Refuse when the document exists (a `new_*` tool must not overwrite by accident). */
  create?: boolean;
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
  const n = await normalizeFor(host, ref.kind, json);
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
  const { created } = await host.write(ref, n.value);
  const warnings = n.issues.filter((i) => i.severity === "warning");
  const verb = opts.verb ?? (created ? "Created" : "Updated");
  const adjusted =
    warnings.length > 0
      ? `\nThese values were adjusted to fit (check they are what you meant):\n${issueLines(warnings)}`
      : "";
  return {
    out: done(
      `${verb} ${name}`,
      `${verb} ${name}.${adjusted}\nIt is saved in the project and visible in the studio now.`
    ),
    value: n.value,
  };
}
