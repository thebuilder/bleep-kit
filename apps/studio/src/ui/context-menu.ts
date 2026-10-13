/* A small pixel context menu, in the top layer like the dropdowns (Popover API) and with the same look (`.dd-pop` and
   `.dd-opt`). It opens at a point (a right click) or under an element (the ContextMenu key, Shift+F10) and is a
   `role="menu"` that holds the focus while it is open.

   Keys: Arrow Up and Down move (and wrap), Home and End jump, Enter or Space pick, Escape closes and gives the focus
   back. Tab closes. It also closes on a click outside, any scroll outside it, a resize and the window losing focus. */
import { h } from "../lib/dom.ts";
import { icon } from "./icons.ts";

export interface MenuItem {
  /** Drawn in the danger color. */
  danger?: boolean;
  /** An icon name from icons.ts. */
  icon?: string;
  label: string;
  run: () => void;
  /** A thin rule above this item. */
  separator?: boolean;
}

interface MenuOpts {
  label?: string;
  /** Gets the focus back when the menu closes without a pick, or after one. */
  restore?: HTMLElement | null;
}

const MARGIN = 6;
let current: ContextMenu | null = null;

class ContextMenu {
  private readonly items: readonly MenuItem[];
  private readonly opts: MenuOpts;
  private readonly pop: HTMLElement;
  private readonly rows: HTMLElement[];
  private readonly abort = new AbortController();
  private active = -1;

  constructor(items: readonly MenuItem[], opts: MenuOpts) {
    this.items = items;
    this.opts = opts;
    this.rows = items.map((item, i) => this.rowFor(item, i));
    this.pop = h(
      "div",
      {
        "aria-label": opts.label ?? "Actions",
        class: "dd-pop cm-pop",
        popover: "manual",
        role: "menu",
        tabindex: "-1",
      },
      ...this.rows
    );
  }

  private rowFor(item: MenuItem, i: number): HTMLElement {
    const ico = h("span", { "aria-hidden": "true", class: "cm-ico" });
    if (item.icon) {
      ico.innerHTML = icon(item.icon, 16);
    }
    const row = h(
      "div",
      {
        class: `dd-opt cm-opt${item.danger ? " danger" : ""}${item.separator ? " sep" : ""}`,
        id: `cm-${i}`,
        role: "menuitem",
      },
      ico,
      h("span", { class: "dd-txt" }, item.label)
    );
    row.addEventListener("click", () => this.pick(i));
    row.addEventListener("pointermove", () => {
      if (this.active !== i) {
        this.setActive(i);
      }
    });
    return row;
  }

  open(at: { x: number; y: number }): void {
    const { pop } = this;
    document.body.append(pop);
    try {
      pop.showPopover?.();
    } catch {
      // unsupported or already showing: it is still a fixed, high layer
    }
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    pop.style.left = `${Math.max(MARGIN, Math.min(at.x, vw - pop.offsetWidth - MARGIN))}px`;
    pop.style.top = `${Math.max(MARGIN, Math.min(at.y, vh - pop.offsetHeight - MARGIN))}px`;
    this.listen();
    this.setActive(0);
    pop.focus({ preventScroll: true });
  }

  close(refocus: boolean): void {
    if (current !== this) {
      return;
    }
    current = null;
    this.abort.abort();
    try {
      this.pop.hidePopover?.();
    } catch {
      // it was not showing
    }
    this.pop.remove();
    const back = this.opts.restore;
    if (refocus && back?.isConnected) {
      back.focus({ preventScroll: true });
    }
  }

  private pick(i: number): void {
    const item = this.items[i];
    this.close(true);
    item?.run();
  }

  private setActive(i: number): void {
    this.rows[this.active]?.classList.remove("act");
    this.active = i;
    const row = this.rows[i];
    if (row) {
      row.classList.add("act");
      this.pop.setAttribute("aria-activedescendant", row.id);
    }
  }

  private step(dir: 1 | -1): void {
    const n = this.rows.length;
    this.setActive((this.active + dir + n) % n);
  }

  /** True when the key did something. */
  private handleKey(key: string): boolean {
    const keys: Record<string, () => void> = {
      " ": () => this.pick(Math.max(0, this.active)),
      ArrowDown: () => this.step(1),
      ArrowUp: () => this.step(-1),
      End: () => this.setActive(this.rows.length - 1),
      Enter: () => this.pick(Math.max(0, this.active)),
      Escape: () => this.close(true),
      Home: () => this.setActive(0),
    };
    const run = keys[key];
    run?.();
    return run !== undefined;
  }

  /** Every key while open goes through here (window capture phase), so the studio's shortcuts never see them. */
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    if (e.key === "Tab") {
      // focus goes back to the opener and the browser moves on from there
      this.close(true);
      return;
    }
    e.stopPropagation();
    if (this.handleKey(e.key)) {
      e.preventDefault();
    }
  };

  private outside(t: EventTarget | null): boolean {
    return !(t instanceof Node && this.pop.contains(t));
  }

  private listen(): void {
    const opts = { capture: true, signal: this.abort.signal };
    const closeOutside = (e: Event) => {
      if (this.outside(e.target)) {
        this.close(false);
      }
    };
    window.addEventListener("keydown", this.onKey, opts);
    window.addEventListener("pointerdown", closeOutside, opts);
    window.addEventListener("scroll", closeOutside, opts);
    window.addEventListener("resize", () => this.close(false), opts);
    // only the window itself losing focus (a capturing listener also sees the blur of every element)
    window.addEventListener(
      "blur",
      (e) => e.target === window && this.close(false),
      opts
    );
  }
}

/** Close the menu that is open, if any. */
function closeContextMenu(refocus = false): void {
  current?.close(refocus);
}

/** Open `items` with the corner at `at` (CSS pixels in the viewport), moved in if it would leave the screen. Only one
 *  menu is open at a time, and the dropdown lists close it as they take the focus. */
export function openContextMenu(
  items: readonly MenuItem[],
  at: { x: number; y: number },
  opts: MenuOpts = {}
): void {
  closeContextMenu();
  if (items.length === 0) {
    return;
  }
  const menu = new ContextMenu(items, opts);
  current = menu;
  menu.open(at);
}
