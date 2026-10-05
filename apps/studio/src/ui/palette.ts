/* The command palette (Ctrl+K): every action by name, fuzzy matched, plus every document. */
import type { Command } from "../app.ts";
import { h } from "../lib/dom.ts";
import { icon } from "./icons.ts";
import { openModal } from "./modal.ts";

/** Subsequence match with a score: consecutive and word-start matches rank higher. null when it does not match. */
export function fuzzy(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = text.toLowerCase();
  if (!q) {
    return 0;
  }
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) {
      return null;
    }
    score += at === prev + 1 ? 6 : 1;
    if (at === 0 || t[at - 1] === " " || t[at - 1] === "/") {
      score += 4;
    }
    prev = at;
    ti = at + 1;
  }
  return score - t.length * 0.02;
}

export function openPalette(commands: Command[]): void {
  const input = h("input", {
    "aria-label": "Command",
    class: "big",
    placeholder: "Type a command or a document name",
    type: "text",
  }) as HTMLInputElement;
  const list = h("div", { class: "cmd-list", role: "listbox" });
  let sel = 0;
  let shown: Command[] = [];
  let close: () => void = () => undefined;
  const run = (c: Command | undefined) => {
    if (!c) {
      return;
    }
    close();
    setTimeout(() => c.run(), 0);
  };
  function render(): void {
    const q = input.value;
    shown = commands
      .filter((c) => c.enabled?.() !== false)
      .map((c) => ({ c, s: fuzzy(q, `${c.group} ${c.title}`) }))
      .filter((x): x is { c: Command; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.c);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.replaceChildren(
      ...shown.map((c, i) => {
        const b = h("button", {
          class: `cmd${i === sel ? " sel" : ""}`,
          onclick: () => run(c),
          role: "option",
        });
        b.innerHTML = `${icon(c.icon ?? "right", 14)}<span class="nm"></span><span class="muted mono" style="font-size:11px"></span>`;
        (b.querySelector(".nm") as HTMLElement).textContent = c.title;
        (b.querySelector("span.muted") as HTMLElement).textContent =
          c.keys ?? c.group;
        return b;
      })
    );
    if (shown.length === 0) {
      list.replaceChildren(h("div", { class: "tree-empty" }, "No match."));
    }
    list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }
  input.addEventListener("input", () => {
    sel = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      sel = Math.min(shown.length - 1, sel + 1);
      render();
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      sel = Math.max(0, sel - 1);
      render();
      e.preventDefault();
    } else if (e.key === "Enter") {
      run(shown[sel]);
      e.preventDefault();
    }
  });
  close = openModal(h("div", {}, input, list));
  render();
  input.focus();
}
