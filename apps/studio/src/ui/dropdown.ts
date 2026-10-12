/* Pixel-art dropdowns for every <select> in the studio.

   The real <select> stays in the DOM as the source of truth (visually hidden, out of the tab order): code keeps reading
   `.value`, setting options and listening for `change` exactly as before. Next to it sits a button that shows the
   current choice, and clicking it opens a listbox in the top layer (Popover API, so no scroll container or modal can
   clip it), placed by measuring the button so it flips above near the bottom of the screen and scrolls when long.
   The same markup and CSS run in Chrome, Safari and Firefox; the customizable-select CSS (`appearance: base-select`)
   is not in Firefox, and the native picker cannot be styled, so this one small component is used everywhere.

   Pattern: a button (aria-haspopup="listbox") that opens a listbox. Focus moves into the listbox, which keeps
   aria-activedescendant on the highlighted option; Escape, Tab and choosing return focus to the button.
   Keys: arrows, Home, End, PageUp, PageDown, type-ahead, Enter or Space to choose, Escape, Tab. */
import { h } from "../lib/dom.ts";
import { icon } from "./icons.ts";

const NATIVE = "dd-native";
const MARGIN = 6;
const MAX_HEIGHT = 360;
const TYPE_RESET_MS = 700;
const OPEN_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", " "]);

let nextId = 0;
let current: Dropdown | null = null;
const registry = new WeakMap<HTMLSelectElement, Dropdown>();
const installed = new WeakMap<Document, MutationObserver>();

const iconHtml = (el: HTMLElement, name: string): HTMLElement => {
  el.innerHTML = icon(name, 16);
  return el;
};

class Dropdown {
  readonly button: HTMLButtonElement;
  readonly select: HTMLSelectElement;
  private readonly id: string;
  private readonly cur = h("span", { class: "dd-cur" });
  private readonly sizer = h("span", { "aria-hidden": "true", class: "dd-sz" });
  private labels: string[] = [];
  private sizerKey = "";
  private pop: HTMLElement | null = null;
  private rows: HTMLElement[] = [];
  private active = -1;
  private typed = "";
  private typedAt = 0;
  private abort: AbortController | null = null;

  constructor(select: HTMLSelectElement) {
    this.select = select;
    nextId += 1;
    this.id = `dd${nextId}`;
    this.button = h(
      "button",
      {
        "aria-controls": `${this.id}-list`,
        "aria-expanded": "false",
        "aria-haspopup": "listbox",
        class: "dd",
        id: this.id,
        type: "button",
      },
      h("span", { class: "dd-val" }, this.cur, this.sizer),
      iconHtml(
        h("span", { "aria-hidden": "true", class: "dd-chev" }),
        "chevron"
      )
    );
    select.classList.add(NATIVE);
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    this.patch();
    this.button.addEventListener("click", () => this.toggle());
    this.button.addEventListener("keydown", this.onButtonKey);
    select.addEventListener("focus", () => this.button.focus());
    select.addEventListener("change", () => this.syncLabel());
    this.refresh();
    if (document.activeElement === select) {
      // a view focused the select before this ran: the button is what takes focus now
      this.attach();
      this.button.focus();
    }
    new MutationObserver(() => this.refresh()).observe(select, {
      attributeFilter: [
        "aria-label",
        "class",
        "disabled",
        "hidden",
        "label",
        "selected",
        "title",
        "value",
      ],
      attributes: true,
      childList: true,
      subtree: true,
    });
  }

  /** Put the button right before its select (again, after the select was moved or rebuilt). */
  attach(): void {
    const { select, button } = this;
    if (select.parentNode && select.previousElementSibling !== button) {
      select.before(button);
    }
  }

  /** The select left the document: take the button with it. */
  detach(): void {
    if (!this.select.isConnected) {
      this.close(false);
      this.button.remove();
    }
  }

  /** `select.value = x` and `selectedIndex` do not fire events, so the label has to follow them directly. */
  private patch(): void {
    const { select } = this;
    for (const key of ["value", "selectedIndex"] as const) {
      const d = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        key
      );
      if (d?.get && d.set) {
        const { get, set } = d;
        Object.defineProperty(select, key, {
          configurable: true,
          get: () => get.call(select),
          set: (v: unknown) => {
            set.call(select, v);
            this.syncLabel();
          },
        });
      }
    }
    select.focus = (o?: FocusOptions) => this.button.focus(o);
  }

  /** Everything the button mirrors from the select: classes, title, disabled, hidden, name, options, value. */
  private refresh(): void {
    const { select, button } = this;
    button.className = [
      "dd",
      ...Array.from(select.classList).filter((c) => c !== NATIVE),
    ].join(" ");
    button.disabled = select.disabled;
    button.hidden = select.hidden;
    if (select.title) {
      button.title = select.title;
    } else {
      button.removeAttribute("title");
    }
    this.labels = Array.from(select.options, (o) => o.text);
    const key = this.labels.join("\u0000");
    if (key !== this.sizerKey) {
      this.sizerKey = key;
      this.sizer.replaceChildren(...this.labels.map((l) => h("span", {}, l)));
    }
    this.syncLabel();
    if (select.disabled) {
      this.close(false);
    } else if (this.pop) {
      this.rebuild();
    }
  }

  private name(): string {
    const aria = this.select.getAttribute("aria-label");
    if (aria) {
      return aria;
    }
    const label = Array.from(this.select.labels ?? []).find(
      (l) => !l.contains(this.select)
    );
    return label?.textContent?.trim() ?? "";
  }

  private syncLabel(): void {
    const text = this.select.options[this.select.selectedIndex]?.text ?? "";
    this.cur.textContent = text;
    const name = this.name();
    if (name) {
      this.button.setAttribute("aria-label", `${name}: ${text}`);
    } else {
      this.button.removeAttribute("aria-label");
    }
  }

  /* ----- open and close ----- */
  private toggle(): void {
    if (this.pop) {
      this.close(true);
    } else {
      this.open();
    }
  }

  open(): void {
    if (this.select.disabled || this.pop || !this.button.isConnected) {
      return;
    }
    current?.close(false);
    const list = h("div", {
      "aria-label": this.name(),
      class: "dd-pop",
      id: `${this.id}-list`,
      popover: "manual",
      role: "listbox",
      tabindex: "-1",
    });
    this.pop = list;
    document.body.append(list);
    this.buildRows();
    try {
      list.showPopover?.();
    } catch {
      // not showable (already open or unsupported): it still works as a fixed, high z-index layer
    }
    this.button.setAttribute("aria-expanded", "true");
    current = this;
    this.listen();
    this.place();
    this.setActive(this.startIndex());
    list.focus({ preventScroll: true });
  }

  close(refocus: boolean): void {
    const { pop } = this;
    if (!pop) {
      return;
    }
    this.abort?.abort();
    this.abort = null;
    try {
      pop.hidePopover?.();
    } catch {
      // it was not showing
    }
    pop.remove();
    this.pop = null;
    this.rows = [];
    this.active = -1;
    this.typed = "";
    this.button.setAttribute("aria-expanded", "false");
    if (current === this) {
      current = null;
    }
    if (refocus) {
      this.button.focus();
    }
  }

  /** While open: keys, outside clicks, scrolling and focus moves are all handled here, on the window. */
  private listen(): void {
    this.abort = new AbortController();
    const opts = { capture: true, signal: this.abort.signal };
    const inside = (t: EventTarget | null) =>
      t instanceof Node &&
      (this.pop?.contains(t) === true || this.button.contains(t));
    window.addEventListener("keydown", this.onKey, opts);
    window.addEventListener(
      "pointerdown",
      (e) => {
        if (!inside(e.target)) {
          this.close(false);
        }
      },
      opts
    );
    window.addEventListener(
      "focusin",
      (e) => {
        if (!inside(e.target)) {
          this.close(false);
        }
      },
      opts
    );
    window.addEventListener("scroll", (e) => this.onScroll(e), opts);
    window.addEventListener("resize", () => this.place(), opts);
    // only the window itself losing focus (not the blur of an element, which a capturing listener also sees)
    window.addEventListener(
      "blur",
      (e) => {
        if (e.target === window) {
          this.close(false);
        }
      },
      opts
    );
  }

  private onScroll(e: Event): void {
    if (e.target instanceof Node && this.pop?.contains(e.target)) {
      return;
    }
    const r = this.button.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      this.close(false);
    } else {
      this.place();
    }
  }

  /** Under the button, or above it when there is more room there; as tall as the list, up to the room left. */
  private place(): void {
    const { pop } = this;
    if (!pop) {
      return;
    }
    const r = this.button.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const look = getComputedStyle(this.button);
    pop.style.fontFamily = look.fontFamily;
    pop.style.fontSize = `${Math.max(12, Number.parseFloat(look.fontSize) || 14)}px`;
    pop.style.maxHeight = "none";
    pop.style.minWidth = `${r.width}px`;
    const natural = pop.offsetHeight;
    const below = vh - r.bottom - MARGIN;
    const above = r.top - MARGIN;
    const down = natural <= below || below >= above;
    pop.style.maxHeight = `${Math.max(
      60,
      Math.min(natural, down ? below : above, MAX_HEIGHT)
    )}px`;
    const height = pop.offsetHeight;
    pop.style.left = `${Math.max(MARGIN, Math.min(r.left, vw - pop.offsetWidth - MARGIN))}px`;
    pop.style.top = `${down ? r.bottom - 1 : r.top - height + 1}px`;
  }

  /* ----- options ----- */
  private buildRows(): void {
    const { pop, select } = this;
    if (!pop) {
      return;
    }
    this.rows = Array.from(select.options, (o, i) => {
      const row = h(
        "div",
        {
          "aria-disabled": o.disabled ? "true" : null,
          "aria-selected": i === select.selectedIndex ? "true" : "false",
          class: "dd-opt",
          "data-i": i,
          id: `${this.id}-o${i}`,
          role: "option",
        },
        iconHtml(
          h("span", { "aria-hidden": "true", class: "dd-tick" }),
          "check"
        ),
        h("span", { class: "dd-txt" }, o.text)
      );
      row.addEventListener("click", () => this.choose(i));
      row.addEventListener("pointermove", () => {
        if (this.active !== i && !o.disabled) {
          this.setActive(i, false);
        }
      });
      return row;
    });
    pop.replaceChildren(...this.rows);
  }

  /** The options changed (the assistant's model list arrives later) while the list is open. */
  private rebuild(): void {
    const keep = this.active;
    this.buildRows();
    this.place();
    this.setActive(Math.min(keep, this.rows.length - 1));
  }

  private startIndex(): number {
    const at = this.select.selectedIndex;
    return at >= 0 ? at : this.edge(1);
  }

  private disabledAt(i: number): boolean {
    return this.select.options[i]?.disabled ?? true;
  }

  /** The first (1) or last (-1) option that can be chosen. */
  private edge(dir: 1 | -1): number {
    const n = this.rows.length;
    for (let k = 0; k < n; k += 1) {
      const i = dir === 1 ? k : n - 1 - k;
      if (!this.disabledAt(i)) {
        return i;
      }
    }
    return -1;
  }

  private setActive(i: number, scroll = true): void {
    const { pop } = this;
    if (!pop) {
      return;
    }
    this.rows[this.active]?.classList.remove("act");
    this.active = i;
    const row = this.rows[i];
    if (!row) {
      pop.removeAttribute("aria-activedescendant");
      return;
    }
    row.classList.add("act");
    pop.setAttribute("aria-activedescendant", row.id);
    if (scroll) {
      this.reveal(pop, row, i);
    }
  }

  private reveal(pop: HTMLElement, row: HTMLElement, i: number): void {
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (i === 0 || top < pop.scrollTop) {
      pop.scrollTop = i === 0 ? 0 : top;
    } else if (i === this.rows.length - 1) {
      pop.scrollTop = pop.scrollHeight;
    } else if (bottom > pop.scrollTop + pop.clientHeight) {
      pop.scrollTop = bottom - pop.clientHeight;
    }
  }

  /** Move by `delta` enabled options (negative goes up), stopping at the ends. */
  private step(delta: number): void {
    const dir = delta < 0 ? -1 : 1;
    let at = this.active;
    for (let n = Math.abs(delta); n > 0; n -= 1) {
      let next = at + dir;
      while (this.rows[next] && this.disabledAt(next)) {
        next += dir;
      }
      if (!this.rows[next]) {
        break;
      }
      at = next;
    }
    this.setActive(at);
  }

  private pageSize(): number {
    const rowH = this.rows[0]?.offsetHeight || 28;
    return Math.max(1, Math.floor((this.pop?.clientHeight ?? 0) / rowH) - 1);
  }

  /** Type-ahead: letters typed within a moment make one prefix; one letter repeated cycles through its matches. */
  private type(ch: string): void {
    const now = Date.now();
    if (now - this.typedAt > TYPE_RESET_MS) {
      this.typed = "";
    }
    this.typedAt = now;
    this.typed += ch.toLowerCase();
    const same = this.typed.replaceAll(this.typed.charAt(0), "") === "";
    const needle = same ? this.typed.slice(0, 1) : this.typed;
    const from = same ? this.active + 1 : this.active;
    const n = this.labels.length;
    for (let k = 0; k < n; k += 1) {
      const i = (Math.max(from, 0) + k) % n;
      if (
        !this.disabledAt(i) &&
        (this.labels[i] ?? "").trim().toLowerCase().startsWith(needle)
      ) {
        this.setActive(i);
        return;
      }
    }
  }

  /** Choose an option: close, then change the select and tell its listeners (only when the value really changes). */
  private choose(i: number): void {
    const { select } = this;
    if (i < 0 || this.disabledAt(i)) {
      return;
    }
    this.close(true);
    if (select.selectedIndex !== i) {
      select.selectedIndex = i;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  /* ----- keys ----- */
  private readonly onButtonKey = (e: KeyboardEvent): void => {
    if (
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      this.select.disabled ||
      this.pop
    ) {
      return;
    }
    const printable = e.key.length === 1 && e.key !== " ";
    if (OPEN_KEYS.has(e.key) || printable) {
      e.preventDefault();
      e.stopPropagation();
      this.open();
      if (printable) {
        this.type(e.key);
      }
    }
  };

  /** Every key while open goes through here (window capture phase), so the modal's Escape and the studio's
   *  shortcuts never see them. Shortcuts with Ctrl, Meta or Alt pass through untouched. */
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    if (this.handleKey(e)) {
      e.preventDefault();
    }
    e.stopPropagation();
  };

  /** True when the key did something. */
  private handleKey(e: KeyboardEvent): boolean {
    const jump: Record<string, () => void> = {
      ArrowDown: () => this.step(1),
      ArrowUp: () => this.step(-1),
      End: () => this.setActive(this.edge(-1)),
      Home: () => this.setActive(this.edge(1)),
      PageDown: () => this.step(this.pageSize()),
      PageUp: () => this.step(-this.pageSize()),
    };
    const move = jump[e.key];
    if (move) {
      move();
      return true;
    }
    return this.handleAction(e);
  }

  private handleAction(e: KeyboardEvent): boolean {
    const typing =
      this.typed !== "" && Date.now() - this.typedAt <= TYPE_RESET_MS;
    if (e.key === "Escape") {
      this.close(true);
    } else if (e.key === "Tab") {
      // focus goes back to the button and the browser moves on from there
      this.close(true);
      return false;
    } else if (e.key === "Enter" || (e.key === " " && !typing)) {
      this.finishWithKey(e.key);
    } else if (e.key.length === 1) {
      this.type(e.key);
    } else {
      return false;
    }
    return true;
  }

  private finishWithKey(key: string): void {
    this.choose(this.active);
    if (key === " ") {
      // the key-up of this Space lands on the button, which must not count it as a click
      this.button.addEventListener("keyup", (ev) => ev.preventDefault(), {
        once: true,
      });
    }
  }
}

/** Give one select the pixel dropdown. Returns its button, or null for the selects that stay native (`multiple`,
 *  a `size`, or `data-native`). Safe to call again: the select is only enhanced once. */
export function enhanceSelect(
  select: HTMLSelectElement
): HTMLButtonElement | null {
  if (
    select.multiple ||
    select.size > 1 ||
    select.hasAttribute("data-native")
  ) {
    return null;
  }
  let dd = registry.get(select);
  if (!dd) {
    dd = new Dropdown(select);
    registry.set(select, dd);
  }
  dd.attach();
  return dd.button;
}

function selectsIn(node: Node): HTMLSelectElement[] {
  if (node instanceof HTMLSelectElement) {
    return [node];
  }
  return node instanceof Element
    ? Array.from(node.querySelectorAll("select"))
    : [];
}

/** Enhance every select now and every select added to the document later (views build them with plain `h("select")`).
 *  Returns a function that stops watching. */
export function installDropdowns(doc: Document = document): () => void {
  const existing = installed.get(doc);
  if (existing) {
    return () => existing.disconnect();
  }
  for (const s of doc.querySelectorAll("select")) {
    enhanceSelect(s);
  }
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of rec.removedNodes) {
        for (const s of selectsIn(node)) {
          registry.get(s)?.detach();
        }
      }
      for (const node of rec.addedNodes) {
        for (const s of selectsIn(node)) {
          enhanceSelect(s);
        }
      }
    }
  });
  observer.observe(doc, { childList: true, subtree: true });
  installed.set(doc, observer);
  return () => {
    observer.disconnect();
    installed.delete(doc);
  };
}
