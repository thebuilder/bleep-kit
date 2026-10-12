/* The little markdown a chat reply needs, built as DOM nodes (never as HTML text, so nothing a model writes can inject
   markup): paragraphs, bullet and numbered lists, headings, code fences, `code` and **bold**. */
import { h } from "../lib/dom.ts";

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^#{1,4}\s+(.*)$/;
const FENCE = /^\s*```/;

function inline(text: string): (Node | string)[] {
  return text.split(INLINE).map((part) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return h("code", {}, part.slice(1, -1));
    }
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return h("strong", {}, part.slice(2, -2));
    }
    return part;
  });
}

interface Builder {
  blocks: HTMLElement[];
  code: string[] | null;
  list: { items: HTMLElement[]; ordered: boolean } | null;
  para: string[];
}

function flushPara(b: Builder): void {
  if (b.para.length > 0) {
    b.blocks.push(h("p", { class: "md-p" }, inline(b.para.join("\n"))));
    b.para = [];
  }
}

function flushList(b: Builder): void {
  if (b.list) {
    b.blocks.push(h(b.list.ordered ? "ol" : "ul", {}, b.list.items));
    b.list = null;
  }
}

function addItem(b: Builder, text: string, ordered: boolean): void {
  flushPara(b);
  if (b.list && b.list.ordered !== ordered) {
    flushList(b);
  }
  b.list ??= { items: [], ordered };
  b.list.items.push(h("li", {}, inline(text)));
}

function line(b: Builder, text: string): void {
  const bullet = BULLET.exec(text);
  const numbered = NUMBERED.exec(text);
  const heading = HEADING.exec(text);
  if (bullet) {
    addItem(b, bullet[1] ?? "", false);
  } else if (numbered) {
    addItem(b, numbered[1] ?? "", true);
  } else if (heading) {
    flushPara(b);
    flushList(b);
    b.blocks.push(h("p", { class: "md-p md-h" }, inline(heading[1] ?? "")));
  } else if (text.trim() === "") {
    flushPara(b);
    flushList(b);
  } else {
    flushList(b);
    b.para.push(text);
  }
}

/** Block elements for a reply's text. An unfinished code fence (a reply still streaming) is shown as code so far. */
export function renderMarkdown(text: string): HTMLElement[] {
  const b: Builder = { blocks: [], code: null, list: null, para: [] };
  for (const raw of text.split("\n")) {
    if (FENCE.test(raw)) {
      if (b.code) {
        b.blocks.push(h("pre", {}, h("code", {}, b.code.join("\n"))));
        b.code = null;
      } else {
        flushPara(b);
        flushList(b);
        b.code = [];
      }
    } else if (b.code) {
      b.code.push(raw);
    } else {
      line(b, raw);
    }
  }
  if (b.code) {
    b.blocks.push(h("pre", {}, h("code", {}, b.code.join("\n"))));
  }
  flushPara(b);
  flushList(b);
  return b.blocks;
}
