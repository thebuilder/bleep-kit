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
    openCount--;
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
  openCount++;
  return close;
}
