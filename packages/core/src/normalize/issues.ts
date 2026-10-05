/* Shared helpers for the normalize functions: issue collection and typed field readers.
   Every reader returns a valid value whatever came in and records what it had to change. */

import type { Issue } from "../types.ts";

export type Rec = Record<string, unknown>;

export interface Ctx {
  issues: Issue[];
}

export function newCtx(): Ctx {
  return { issues: [] };
}

export function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Append one reference token to a JSON pointer (RFC 6901 escaping). */
export function ptr(base: string, key: string | number): string {
  const k = String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${base}/${k}`;
}

/** A short description of a value for "(was ...)" in messages. */
export function show(v: unknown): string {
  if (v === undefined) {
    return "missing";
  }
  if (v === null) {
    return "null";
  }
  if (typeof v === "number") {
    return Number.isNaN(v) ? "NaN" : String(v);
  }
  if (typeof v === "string") {
    return JSON.stringify(v.length > 24 ? `${v.slice(0, 21)}...` : v);
  }
  if (typeof v === "boolean") {
    return String(v);
  }
  if (Array.isArray(v)) {
    return "an array";
  }
  return typeof v === "object" ? "an object" : typeof v;
}

export function error(ctx: Ctx, path: string, message: string): void {
  ctx.issues.push({ message, path, severity: "error" });
}

export function warn(ctx: Ctx, path: string, message: string): void {
  ctx.issues.push({ message, path, severity: "warning" });
}

/** One issue per line: "error /envelope/attack: must be 0 to 4 (was 9)". The root path prints as "(root)". */
export function issuesToText(issues: readonly Issue[]): string {
  return issues
    .map(
      (i) => `${i.severity} ${i.path === "" ? "(root)" : i.path}: ${i.message}`
    )
    .join("\n");
}

export function hasErrors(issues: readonly Issue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

/** A required nested object. Missing yields {} silently; the wrong type is an error. */
export function section(
  ctx: Ctx,
  parent: Rec,
  key: string,
  path: string,
  required = false
): Rec {
  const v = parent[key];
  const p = ptr(path, key);
  if (v === undefined) {
    if (required) {
      error(ctx, p, "is required");
    }
    return {};
  }
  if (!isRec(v)) {
    error(ctx, p, `must be an object (was ${show(v)})`);
    return {};
  }
  return v;
}

/** Warn about every key of obj that is not in known. */
export function dropUnknown(
  ctx: Ctx,
  obj: Rec,
  path: string,
  known: readonly string[]
): void {
  for (const k of Object.keys(obj)) {
    if (!known.includes(k)) {
      warn(ctx, ptr(path, k), `unknown field "${k}" was dropped`);
    }
  }
}

export interface NumOpts {
  def: number;
  int?: boolean;
  max: number;
  min: number;
  required?: boolean;
}

/** Clamp a number into a range, recording a warning when it was outside. Pure helper for values already read. */
export function clampNum(
  ctx: Ctx,
  value: number,
  path: string,
  o: { min: number; max: number; int?: boolean }
): number {
  let v = value;
  if (o.int && !Number.isInteger(v)) {
    const r = Math.round(v);
    warn(ctx, path, `must be a whole number (was ${v})`);
    v = r;
  }
  if (v < o.min || v > o.max) {
    const c = Math.min(o.max, Math.max(o.min, v));
    warn(ctx, path, `must be ${o.min} to ${o.max} (was ${v})`);
    v = c;
  }
  return v;
}

export function numField(
  ctx: Ctx,
  obj: Rec,
  key: string,
  path: string,
  o: NumOpts
): number {
  const v = obj[key];
  const p = ptr(path, key);
  if (v === undefined) {
    if (o.required) {
      error(ctx, p, "is required");
    }
    return o.def;
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    error(ctx, p, `must be a number (was ${show(v)})`);
    return o.def;
  }
  return clampNum(ctx, v, p, o);
}

/** A number or null. Missing and null both give null. */
export function nullableNumField(
  ctx: Ctx,
  obj: Rec,
  key: string,
  path: string,
  o: { min: number; max: number; int?: boolean; def: number | null }
): number | null {
  const v = obj[key];
  if (v === undefined || v === null) {
    return v === undefined ? o.def : null;
  }
  const p = ptr(path, key);
  if (typeof v !== "number" || !Number.isFinite(v)) {
    error(ctx, p, `must be a number or null (was ${show(v)})`);
    return o.def;
  }
  return clampNum(ctx, v, p, o);
}

export function strField(
  ctx: Ctx,
  obj: Rec,
  key: string,
  path: string,
  def: string,
  o: { required?: boolean; maxLen?: number } = {}
): string {
  const v = obj[key];
  const p = ptr(path, key);
  if (v === undefined) {
    if (o.required) {
      error(ctx, p, "is required");
    }
    return def;
  }
  if (typeof v !== "string") {
    error(ctx, p, `must be a string (was ${show(v)})`);
    return def;
  }
  if (o.maxLen !== undefined && v.length > o.maxLen) {
    warn(
      ctx,
      p,
      `must be at most ${o.maxLen} characters (was ${v.length}), truncated`
    );
    return v.slice(0, o.maxLen);
  }
  return v;
}

export function boolField(
  ctx: Ctx,
  obj: Rec,
  key: string,
  path: string,
  def: boolean
): boolean {
  const v = obj[key];
  if (v === undefined) {
    return def;
  }
  if (typeof v !== "boolean") {
    error(ctx, ptr(path, key), `must be true or false (was ${show(v)})`);
    return def;
  }
  return v;
}

export function enumField<T extends string | number>(
  ctx: Ctx,
  obj: Rec,
  key: string,
  path: string,
  allowed: readonly T[],
  def: T,
  required = false
): T {
  const v = obj[key];
  const p = ptr(path, key);
  if (v === undefined) {
    if (required) {
      error(ctx, p, "is required");
    }
    return def;
  }
  const hit = allowed.find((a) => a === v);
  if (hit === undefined) {
    error(ctx, p, `must be one of ${allowed.join(", ")} (was ${show(v)})`);
    return def;
  }
  return hit;
}

/** Document ids: lowercase letters, digits and dashes. */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidId(s: string): boolean {
  return ID_RE.test(s);
}

/** Read the optional `id` field: kept as given when well formed, error and dropped otherwise. */
export function readId(ctx: Ctx, obj: Rec): string | undefined {
  const v = obj.id;
  if (v === undefined) {
    return undefined;
  }
  if (typeof v !== "string" || !ID_RE.test(v)) {
    error(
      ctx,
      "/id",
      `must be lowercase letters, digits and dashes, 1 to 64 characters (was ${show(v)})`
    );
    return undefined;
  }
  return v;
}

/** Read and check the version field. Returns the version to migrate from (1 when missing or invalid). */
export function readVersion(ctx: Ctx, obj: Rec, current: number): number {
  const v = obj.version;
  if (v === undefined) {
    warn(ctx, "/version", `is missing, assuming ${current}`);
    return current;
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    error(ctx, "/version", `must be a whole number from 1 (was ${show(v)})`);
    return current;
  }
  if (v > current) {
    error(
      ctx,
      "/version",
      `is ${v} but this build reads up to version ${current}`
    );
    return current;
  }
  return v;
}

export function finish<T>(
  ctx: Ctx,
  value: T
): { ok: boolean; value: T; issues: Issue[] } {
  return { issues: ctx.issues, ok: !hasErrors(ctx.issues), value };
}
