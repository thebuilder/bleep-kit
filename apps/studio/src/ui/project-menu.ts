/* The project menu in the top bar: the project's name as a button that opens a small menu with the actions people look
   for (new project, open or import, export, start over). The actions live in project-actions.ts, which the command
   palette uses too. An action that does not apply to the current store stays in the list, dimmed, and says why in its
   tooltip and in a toast. */
import { app } from "../app.ts";
import { choose, h } from "../lib/dom.ts";
import { projectActions } from "../project-actions.ts";
import { project } from "../state/docs.ts";
import { icon } from "./icons.ts";

/** Actions that start a new group in the menu (a thin rule above them). */
const GROUP_STARTS = new Set(["open", "export-zip", "start-over"]);

export function createProjectMenu(host: HTMLElement): { close: () => void } {
  const name = h("span", { class: "pn" });
  const btn = h("button", {
    "aria-expanded": "false",
    "aria-haspopup": "menu",
    "aria-label": "Project menu",
    class: "pmenu-btn",
    id: "projMenuBtn",
    title: "Project menu: new, open, export, start over",
    type: "button",
  });
  btn.innerHTML = `${icon("folder", 16)}`;
  btn.append(name);
  btn.insertAdjacentHTML("beforeend", icon("down", 12));
  const list = h("div", {
    "aria-label": "Project",
    class: "pmenu-list",
    hidden: true,
    role: "menu",
  });
  host.replaceChildren(btn, list);

  const syncName = () => {
    name.textContent = project.project.name.trim() || "Untitled";
  };
  const items = (): HTMLButtonElement[] =>
    Array.from(list.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));

  function close(): void {
    if (list.hidden) {
      return;
    }
    list.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function onOutside(e: Event): void {
    if (!host.contains(e.target as Node)) {
      close();
    }
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      close();
      btn.focus();
      return;
    }
    const step = choose<number>(
      [
        [e.key === "ArrowDown", 1],
        [e.key === "ArrowUp", -1],
      ],
      0
    );
    if (step) {
      e.preventDefault();
      const all = items();
      const at = all.indexOf(document.activeElement as HTMLButtonElement);
      all[(at + step + all.length) % all.length]?.focus();
    } else if (e.key === "Tab") {
      close();
    }
  }
  function render(): void {
    list.replaceChildren(
      h(
        "div",
        { class: "pmenu-h" },
        h("b", {}, project.project.name.trim() || "Untitled"),
        h(
          "small",
          {},
          project.store.mode === "local"
            ? "In this browser"
            : project.store.label
        )
      )
    );
    for (const a of projectActions()) {
      const on = a.available();
      const item = h("button", {
        "aria-disabled": on ? null : "true",
        class: `pmenu-item${on ? "" : " off"}${GROUP_STARTS.has(a.id) ? " sep" : ""}`,
        "data-action": a.id,
        role: "menuitem",
        title: on ? null : a.why,
        type: "button",
      });
      item.innerHTML = `${icon(a.icon, 14)}<span></span>`;
      (item.querySelector("span") as HTMLElement).textContent = a.title;
      item.addEventListener("click", () => {
        close();
        if (on) {
          a.run();
        } else {
          app.toast(a.why);
        }
      });
      list.append(item);
    }
  }
  function open(): void {
    render();
    list.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    items()[0]?.focus();
  }
  btn.addEventListener("click", () => (list.hidden ? open() : close()));
  project.subscribe((e) => {
    if (e.type === "project" || e.type === "list") {
      syncName();
    }
  });
  syncName();
  return { close };
}
