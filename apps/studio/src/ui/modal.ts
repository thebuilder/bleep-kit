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

/** A yes or no question in the studio's own style (never the browser's alert box). Escape or a click outside is "no". */
export function confirmDialog(
  message: string,
  okLabel: string
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
      h(
        "div",
        { class: "confirm-btns" },
        h("button", { class: "btn", onclick: () => answer(false) }, "Cancel"),
        ok
      )
    );
    close = openModal(content, { cls: "narrow", onClose: () => answer(false) });
    ok.focus();
  });
}
