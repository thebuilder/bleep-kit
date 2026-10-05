// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: audio hot paths and long effect switches stay in one function: no call overhead and the order reads like the signal flow
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

export function lex(
  src: string,
  path = "/mml"
): { tokens: Token[]; issues: Issue[] } {
  const tokens: Token[] = [];
  const issues: Issue[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === ";") {
      while (i < src.length && src.charAt(i) !== "\n") {
        i += 1;
      }
      continue;
    }
    if (DIGIT.test(ch)) {
      const start = i;
      while (i < src.length && DIGIT.test(src.charAt(i))) {
        i += 1;
      }
      tokens.push({ kind: "num", pos: start, text: src.slice(start, i) });
      continue;
    }
    if (LETTER.test(ch)) {
      tokens.push({ kind: "word", pos: i, text: ch });
      i += 1;
      continue;
    }
    if (ch === "@") {
      const start = i;
      i += 1;
      const idStart = i;
      while (i < src.length && ID_CHAR.test(src.charAt(i))) {
        i += 1;
      }
      if (i === idStart) {
        issues.push({
          message: `missing instrument id after "@" at offset ${start}`,
          path,
          severity: "error",
        });
        continue;
      }
      tokens.push({ kind: "at", pos: start, text: src.slice(idStart, i) });
      continue;
    }
    if (ch === "{") {
      const start = i;
      const end = src.indexOf("}", i + 1);
      if (end < 0) {
        issues.push({
          message: `unclosed "{" at offset ${start}`,
          path,
          severity: "error",
        });
        break;
      }
      tokens.push({ kind: "fx", pos: start, text: src.slice(start + 1, end) });
      i = end + 1;
      continue;
    }
    const kind = SINGLE[ch];
    if (kind !== undefined) {
      tokens.push({ kind, pos: i, text: ch });
      i += 1;
      continue;
    }
    issues.push({
      message: `unexpected character "${ch}" at offset ${i}`,
      path,
      severity: "error",
    });
    i += 1;
  }
  return { issues, tokens };
}
