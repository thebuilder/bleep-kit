/* MML lexer (section 2.7): whitespace and `;` comments are skipped, every other character becomes a token with its
   character offset so the parser can report errors at a position. */

import type { Issue } from "../types.ts";

export type TokenKind =
  | "word"
  | "num"
  | "plus"
  | "minus"
  | "sharp"
  | "dot"
  | "lt"
  | "gt"
  | "tie"
  | "lbr"
  | "rbr"
  | "bar"
  | "at"
  | "fx"
  | "bad";

export interface Token {
  kind: TokenKind;
  pos: number;
  text: string;
}

const ID_CHAR = /[A-Za-z0-9-]/;
const DIGIT = /[0-9]/;
const LETTER = /[A-Za-z]/;
const WHITESPACE = /[ \t\n\r]/;
const NOT_NEWLINE = /[^\n]/;

const SINGLE: Readonly<Record<string, TokenKind>> = {
  "-": "minus",
  ".": "dot",
  "[": "lbr",
  "]": "rbr",
  "&": "tie",
  "#": "sharp",
  "+": "plus",
  "<": "lt",
  ">": "gt",
  "|": "bar",
};

/** The tokens and issues being collected. */
interface Lexed {
  issues: Issue[];
  tokens: Token[];
}

/** Index of the first character at or after `i` that does not match `re`. */
function skipWhile(src: string, i: number, re: RegExp): number {
  let j = i;
  while (j < src.length && re.test(src.charAt(j))) {
    j += 1;
  }
  return j;
}

function scanNumber(src: string, i: number, out: Lexed): number {
  const end = skipWhile(src, i, DIGIT);
  out.tokens.push({ kind: "num", pos: i, text: src.slice(i, end) });
  return end;
}

/** `@id`: an instrument reference. Returns the index after it. */
function scanInstrument(
  src: string,
  start: number,
  out: Lexed,
  path: string
): number {
  const idStart = start + 1;
  const end = skipWhile(src, idStart, ID_CHAR);
  if (end === idStart) {
    out.issues.push({
      message: `missing instrument id after "@" at offset ${start}`,
      path,
      severity: "error",
    });
  } else {
    out.tokens.push({ kind: "at", pos: start, text: src.slice(idStart, end) });
  }
  return end;
}

/** `{effect}`. An unclosed brace ends the input: the returned index is past the end. */
function scanEffect(
  src: string,
  start: number,
  out: Lexed,
  path: string
): number {
  const end = src.indexOf("}", start + 1);
  if (end < 0) {
    out.issues.push({
      message: `unclosed "{" at offset ${start}`,
      path,
      severity: "error",
    });
    return src.length;
  }
  out.tokens.push({
    kind: "fx",
    pos: start,
    text: src.slice(start + 1, end),
  });
  return end + 1;
}

/** A one character token, or an issue for a character MML does not use. */
function scanSingle(ch: string, i: number, out: Lexed, path: string) {
  const kind = SINGLE[ch];
  if (kind === undefined) {
    out.issues.push({
      message: `unexpected character "${ch}" at offset ${i}`,
      path,
      severity: "error",
    });
  } else {
    out.tokens.push({ kind, pos: i, text: ch });
  }
}

export function lex(
  src: string,
  path = "/mml"
): { tokens: Token[]; issues: Issue[] } {
  const out: Lexed = { issues: [], tokens: [] };
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (WHITESPACE.test(ch)) {
      i += 1;
    } else if (ch === ";") {
      // a comment runs to the end of the line
      i = skipWhile(src, i, NOT_NEWLINE);
    } else if (DIGIT.test(ch)) {
      i = scanNumber(src, i, out);
    } else if (LETTER.test(ch)) {
      out.tokens.push({ kind: "word", pos: i, text: ch });
      i += 1;
    } else if (ch === "@") {
      i = scanInstrument(src, i, out, path);
    } else if (ch === "{") {
      i = scanEffect(src, i, out, path);
    } else {
      scanSingle(ch, i, out, path);
      i += 1;
    }
  }
  return out;
}
