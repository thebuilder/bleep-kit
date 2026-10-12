/* The reply renderer builds DOM nodes, never HTML from text, so nothing a model writes can inject markup. */
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/assistant/markdown.ts";

const html = (text: string) =>
  renderMarkdown(text)
    .map((n) => n.outerHTML)
    .join("");

describe("renderMarkdown", () => {
  it("makes paragraphs, bold and inline code", () => {
    expect(html("One **two** `three`.\n\nNext.")).toBe(
      '<p class="md-p">One <strong>two</strong> <code>three</code>.</p><p class="md-p">Next.</p>'
    );
  });

  it("groups bullet and numbered lists", () => {
    expect(html("Plan:\n- a\n- b\n1. c\n2. d")).toBe(
      '<p class="md-p">Plan:</p><ul><li>a</li><li>b</li></ul><ol><li>c</li><li>d</li></ol>'
    );
  });

  it("keeps a code fence verbatim, even one still streaming", () => {
    expect(html("```\nt120 l8 cdef\n- not a list\n```")).toBe(
      "<pre><code>t120 l8 cdef\n- not a list</code></pre>"
    );
    expect(html("```\nopen")).toBe("<pre><code>open</code></pre>");
  });

  it("never turns text into markup", () => {
    const out = renderMarkdown("<img src=x onerror=alert(1)> **<b>hi</b>**");
    expect(out).toHaveLength(1);
    expect(out[0]?.querySelector("img")).toBeNull();
    expect(out[0]?.querySelector("b")).toBeNull();
    expect(out[0]?.textContent).toBe("<img src=x onerror=alert(1)> <b>hi</b>");
  });
});
