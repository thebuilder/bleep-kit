/* Modals: an overlay with a panel, closed by Escape or a click outside. */
import { h } from "../lib/dom.ts";

let openCount = 0;
export const modalOpen = (): boolean => openCount > 0;

export function openModal(
  content: HTMLElement,
  opts: { onClose?: () => void; cls?: string } = {}
): () => void {
  const overlay = h("div", {
    "aria-modal": "true",
    class: "overlay",
    role: "dialog",
  });
  const panel = h("div", { class: `modal ${opts.cls ?? ""}` }, content);
  overlay.append(panel);
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    openCount -= 1;
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      close();
    }
  };
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) {
      close();
    }
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  openCount += 1;
  return close;
}

export interface ConfirmOptions {
  /** Modal width class: "narrow" (the default) or "wide", for a question with lists. */
  cls?: "narrow" | "wide";
  /** Titled lists of lines under the question, such as what a change would move or drop. Empty lists are left out. */
  lists?: { lines: string[]; title: string }[];
  signal?: AbortSignal;
}

function listBlocks(lists: ConfirmOptions["lists"]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const { lines, title } of lists ?? []) {
    if (lines.length > 0) {
      out.push(
        h("p", {}, title),
        h("ul", { class: "muted" }, ...lines.map((l) => h("li", {}, l)))
      );
    }
  }
  return out;
}

/** A yes or no question in the studio's own style (never the browser's alert box). Escape or a click outside is "no",
 *  and so is `signal` aborting. */
export function confirmDialog(
  message: string,
  okLabel: string,
  opts: ConfirmOptions = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    let close: () => void = () => undefined;
    const answer = (yes: boolean) => {
      if (answered) {
        return;
      }
      answered = true;
      close();
      resolve(yes);
    };
    const ok = h(
      "button",
      { class: "btn primary", onclick: () => answer(true) },
      okLabel
    );
    const content = h(
      "div",
      { class: "confirm" },
      h("p", {}, message),
      ...listBlocks(opts.lists),
      h(
        "div",
        { class: "confirm-btns" },
        h("button", { class: "btn", onclick: () => answer(false) }, "Cancel"),
        ok
      )
    );
    close = openModal(content, {
      cls: opts.cls ?? "narrow",
      onClose: () => answer(false),
    });
    // the assistant was stopped while its question was open: that is a no
    if (opts.signal?.aborted) {
      answer(false);
    }
    opts.signal?.addEventListener("abort", () => answer(false), { once: true });
    ok.focus();
  });
}
