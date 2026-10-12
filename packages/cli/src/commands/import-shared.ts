/* What the import commands (MIDI, MOD, audio) and resample share: ids from file names, the lines of an issue list, the
   error for a file that does not convert, and a note given as a name or a number. */

import path from "node:path";
import { type Issue, parseNoteName } from "@bleepkit/core";
import { CliError } from "../output.ts";

const DIGITS_RE = /^\d+$/;
const NON_ID_RE = /[^a-z0-9]+/g;
const EDGE_DASH_RE = /^-+|-+$/g;
const EXT_RE = /\.[A-Za-z0-9]+$/;

/** `Boss Theme (v2).wav` becomes `boss-theme-v2`. */
export function idFromName(file: string, fallback: string): string {
  const base = path.basename(file).replace(EXT_RE, "").toLowerCase();
  const id = base
    .replace(NON_ID_RE, "-")
    .replace(EDGE_DASH_RE, "")
    .slice(0, 64)
    .replace(EDGE_DASH_RE, "");
  return id === "" ? fallback : id;
}

function issueLine(i: Issue): string {
  return `  ${i.severity} ${i.path === "" ? "" : `${i.path}: `}${i.message}`;
}

/** A titled list of issues, or nothing when there are none. */
function issueSection(title: string, issues: Issue[]): string[] {
  return issues.length === 0
    ? []
    : [`${title} (${issues.length}):`, ...issues.map(issueLine)];
}

/** The "Converted" (info) and "Lost or changed" (everything else) sections of an import report. */
export function reportSections(issues: Issue[]): string[] {
  return [
    ...issueSection(
      "Converted",
      issues.filter((i) => i.severity === "info")
    ),
    ...issueSection(
      "Lost or changed",
      issues.filter((i) => i.severity !== "info")
    ),
  ];
}

/** The error for a file whose conversion reported errors. */
export function invalidImport(
  file: string,
  issues: Issue[],
  hint: string
): CliError {
  const errors = issues.filter((i) => i.severity === "error");
  return new CliError(
    "invalid",
    `cannot import ${file}:\n${errors.map(issueLine).join("\n")}`,
    { details: { issues }, hint }
  );
}

/** A note flag: a name like C-4 or A#3, or a number 0 to 127. Undefined when absent. */
export function noteFlag(
  text: string | undefined,
  flag: string,
  hint: string
): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  const n = DIGITS_RE.test(text) ? Number(text) : parseNoteName(text);
  if (n === null || n < 0 || n > 127) {
    throw new CliError(
      "usage",
      `--${flag} must be a note name like C-4 or A#3, or 0 to 127 (was "${text}")`,
      { hint }
    );
  }
  return n;
}
