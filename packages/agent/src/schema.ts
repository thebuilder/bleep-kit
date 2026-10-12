// A small JSON Schema validator for tool input. Models send almost-right arguments (a number as a string, a missing
// field, an unknown id); the tools check them here and answer with a precise sentence the model can act on, instead of
// failing somewhere deeper. Understands the subset in `JsonSchema`.
import type { JsonSchema } from "./types.ts";

export type Checked =
  | { ok: true; value: unknown }
  | { ok: false; errors: string[] };

const MAX_ERRORS = 8;
const LEADING_SLASH = /^\//;

const typeName = (v: unknown): string => {
  if (v === null) {
    return "null";
  }
  return Array.isArray(v) ? "array" : typeof v;
};

const quote = (v: unknown): string => {
  const s = String(JSON.stringify(v));
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
};

function checkNumber(
  value: unknown,
  schema: JsonSchema,
  at: string,
  errors: string[]
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${at}: must be a number (was ${typeName(value)})`);
    return;
  }
  if (schema.type === "integer" && !Number.isInteger(value)) {
    errors.push(`${at}: must be a whole number (was ${value})`);
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${at}: must be at least ${schema.minimum} (was ${value})`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push(`${at}: must be at most ${schema.maximum} (was ${value})`);
  }
}

function checkString(
  value: unknown,
  schema: JsonSchema,
  at: string,
  errors: string[]
): void {
  if (typeof value !== "string") {
    errors.push(`${at}: must be a string (was ${typeName(value)})`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(
      `${at}: must be one of ${schema.enum.join(", ")} (was ${quote(value)})`
    );
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${at}: must not be empty`);
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    errors.push(`${at}: must be at most ${schema.maxLength} characters`);
  }
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${at}: must match ${schema.pattern} (was ${quote(value)})`);
  }
}

function checkArray(
  value: unknown,
  schema: JsonSchema,
  at: string,
  errors: string[]
): void {
  if (!Array.isArray(value)) {
    errors.push(`${at}: must be an array (was ${typeName(value)})`);
    return;
  }
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push(`${at}: needs at least ${schema.minItems} items`);
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    errors.push(`${at}: allows at most ${schema.maxItems} items`);
  }
  if (schema.items) {
    for (const [i, item] of value.entries()) {
      walk(item, schema.items, `${at}/${i}`, errors);
    }
  }
}

function checkObject(
  value: unknown,
  schema: JsonSchema,
  at: string,
  errors: string[]
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${at}: must be an object (was ${typeName(value)})`);
    return;
  }
  const rec = value as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (rec[key] === undefined) {
      errors.push(`${at === "" ? "" : `${at}/`}${key}: is required`);
    }
  }
  const props = schema.properties ?? {};
  for (const [key, v] of Object.entries(rec)) {
    const child = props[key];
    if (child) {
      walk(v, child, `${at}/${key}`, errors);
    } else if (typeof schema.additionalProperties === "object") {
      walk(v, schema.additionalProperties, `${at}/${key}`, errors);
    } else if (schema.additionalProperties === false) {
      errors.push(
        `${at}/${key}: unknown field (known: ${Object.keys(props).join(", ")})`
      );
    }
  }
}

function walk(
  value: unknown,
  schema: JsonSchema,
  at: string,
  errors: string[]
): void {
  if (errors.length >= MAX_ERRORS) {
    return;
  }
  const where = at === "" ? "input" : at.replace(LEADING_SLASH, "");
  switch (schema.type) {
    case "number":
    case "integer":
      checkNumber(value, schema, where, errors);
      break;
    case "string":
      checkString(value, schema, where, errors);
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        errors.push(`${where}: must be true or false (was ${typeName(value)})`);
      }
      break;
    case "array":
      checkArray(value, schema, where, errors);
      break;
    case "object":
      checkObject(value, schema, at === "" ? "" : where, errors);
      break;
    default:
      break;
  }
}

/** Check `input` against `schema`: ok with the value, or every problem found (at most 8) as a sentence. */
export function checkInput(input: unknown, schema: JsonSchema): Checked {
  const errors: string[] = [];
  walk(input ?? {}, schema, "", errors);
  return errors.length === 0
    ? { ok: true, value: input ?? {} }
    : { errors, ok: false };
}
