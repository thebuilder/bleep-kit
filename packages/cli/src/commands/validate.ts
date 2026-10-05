import fs from "node:fs";
import path from "node:path";
import { type Issue, normalizeProject } from "@bleepkit/core";
import { CliError } from "../output.ts";
import {
  DOC_KINDS,
  type DocKind,
  docRel,
  ID_PATTERN,
  listIds,
  normalizeDocument,
  openProject,
  type ProjectCtx,
  parseRef,
  readJsonFile,
} from "../project.ts";
import type { CommandSpec } from "./types.ts";

interface ValidationEntry {
  issues: Issue[];
  ok: boolean;
  ref: string;
}

function check(pc: ProjectCtx, kind: DocKind, id: string): ValidationEntry {
  const ref = `${kind}/${id}`;
  const rel = docRel(kind, id);
  const issues: Issue[] = [];
  if (!ID_PATTERN.test(id)) {
    issues.push({
      message: `file name "${id}.json" is not a valid id: use lowercase letters, digits and dashes (rename the file)`,
      path: "",
      severity: "error",
    });
  }
  let raw: unknown;
  try {
    raw = readJsonFile(path.join(pc.root, rel), rel);
  } catch (error) {
    issues.push({
      message: error instanceof CliError ? error.message : String(error),
      path: "",
      severity: "error",
    });
    return { issues, ok: false, ref };
  }
  const n = normalizeDocument(
    kind,
    raw,
    kind === "song" ? pc.instruments() : undefined
  );
  issues.push(...n.issues);
  return { issues, ok: issues.every((i) => i.severity !== "error"), ref };
}

function validateProject(pc: ProjectCtx, refs: string[]): ValidationEntry[] {
  const entries: ValidationEntry[] = [];
  if (refs.length === 0) {
    const raw = readJsonFile(
      path.join(pc.root, "project.json"),
      "project.json"
    );
    const n = normalizeProject(raw);
    entries.push({ issues: n.issues, ok: n.ok, ref: "project" });
    for (const kind of DOC_KINDS) {
      for (const id of listIds(pc.root, kind)) {
        entries.push(check(pc, kind, id));
      }
    }
    return entries;
  }
  for (const ref of refs) {
    if (ref === "project" || ref === "project.json") {
      const n = normalizeProject(
        readJsonFile(path.join(pc.root, "project.json"), "project.json")
      );
      entries.push({ issues: n.issues, ok: n.ok, ref: "project" });
      continue;
    }
    const parsed = parseRef(ref);
    const kinds = parsed.kind ? [parsed.kind] : DOC_KINDS;
    const found = kinds.filter((k) =>
      fs.existsSync(path.join(pc.root, docRel(k, parsed.id)))
    );
    if (found.length === 0) {
      throw new CliError("not-found", `no document "${ref}" in ${pc.root}`, {
        hint: "Run `bleepkit list` to see what exists; refs look like sfx/coin, song/title, instrument/lead.",
      });
    }
    for (const kind of found) {
      entries.push(check(pc, kind, parsed.id));
    }
  }
  return entries;
}

export const validateCommand: CommandSpec = {
  description:
    "Normalizes every document (or the named ones) exactly like the engine does and prints one line per problem with " +
    "a JSON pointer path. Songs are checked against the project's instruments. Exit 1 when any document has errors; " +
    "warnings (clamped numbers, dropped fields) never fail. Run it after every hand edit.",
  examples: [
    "bleepkit validate",
    "bleepkit validate sfx/coin song/title --json",
  ],
  flags: [],
  name: "validate",
  run: (ctx, args) => {
    const pc = openProject(ctx, { lenient: true });
    const entries = validateProject(pc, args.positionals);
    let errors = 0;
    let warnings = 0;
    const lines: string[] = [];
    for (const e of entries) {
      const e1 = e.issues.filter((i) => i.severity === "error").length;
      const w1 = e.issues.length - e1;
      errors += e1;
      warnings += w1;
      if (e.issues.length > 0) {
        lines.push(`${e.ok ? "warn" : "FAIL"}  ${e.ref}`);
        for (const i of e.issues) {
          lines.push(`  ${i.severity} ${i.path || "/"}: ${i.message}`);
        }
      }
    }
    const ok = errors === 0;
    lines.push(
      `${ok ? "ok" : "FAILED"}: ${entries.length} document${entries.length === 1 ? "" : "s"} checked, ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`
    );
    if (!ok) {
      lines.push(
        "Fix the errors above (paths are JSON pointers into the file), then run `bleepkit validate` again."
      );
    }
    return {
      exit: ok ? 0 : 1,
      human: lines.join("\n"),
      json: { documents: entries, ok },
    };
  },
  summary: "check documents; exit 1 on errors",
  usage: "validate [ref...]",
};
