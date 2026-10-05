/* Inspector building blocks: collapsible groups (with an optional lock) and fields laid out as label, control, value.
   Every field is a plain <label> with a range input, number input, select or toggle. */
import { choose, clamp, fmtNum, h, prefs } from "../lib/dom.ts";
import { icon } from "./icons.ts";

export interface Group {
  body: HTMLElement;
  el: HTMLElement;
  locked: () => boolean;
}

export function group(
  title: string,
  opts: { key?: string; closed?: boolean; lock?: boolean; hint?: string } = {}
): Group {
  const key = `grp:${opts.key ?? title}`;
  const closed = prefs.get(key, opts.closed ?? false);
  const body = h("div", { class: "grp-b" });
  const head = h("button", {
    "aria-expanded": closed ? "false" : "true",
    class: "grp-h",
  });
  head.innerHTML = `${icon("down", 12, "chev")}<span class="pxh"></span>`;
  (head.querySelector(".pxh") as HTMLElement).textContent = title;
  let lock = false;
  const el = h(
    "section",
    { class: `grp${closed ? " closed" : ""}` },
    head,
    body
  );
  let lockBtn: HTMLElement | null = null;
  if (opts.lock) {
    lockBtn = h("button", {
      "aria-label": `Lock ${title}`,
      "aria-pressed": "false",
      class: "lk",
      title: "Keep this group fixed while randomizing",
    });
    lockBtn.innerHTML = icon("unlock", 14);
    lockBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      lock = !lock;
      lockBtn?.classList.toggle("on", lock);
      lockBtn?.setAttribute("aria-pressed", String(lock));
      if (lockBtn) {
        lockBtn.innerHTML = icon(lock ? "lock" : "unlock", 14);
      }
    });
    head.append(lockBtn);
  }
  head.addEventListener("click", () => {
    const now = el.classList.toggle("closed");
    head.setAttribute("aria-expanded", String(!now));
    prefs.set(key, now);
  });
  return { body, el, locked: () => lock };
}

export interface RangeOpts {
  digits?: number;
  label: string;
  max: number;
  min: number;
  /** greyed out, with a tooltip saying why */
  off?: string | false;
  onInput: (v: number) => void;
  /** "log" maps the slider logarithmically (min must be above 0) */
  scale?: "linear" | "log";
  step?: number;
  title?: string;
  value: number;
}

export interface FieldHandle {
  el: HTMLElement[];
  set: (v: number) => void;
  setOff: (off: string | false) => void;
}

function mark(
  inputs: HTMLElement[],
  row: HTMLElement[]
): (off: string | false) => void {
  return (off) => {
    for (const el of row) {
      el.classList.toggle("off", !!off);
      if (off) {
        el.title = off;
      } else {
        el.removeAttribute("title");
      }
    }
    for (const i of inputs) {
      (i as HTMLInputElement).disabled = !!off;
    }
  };
}

export function rangeField(body: HTMLElement, o: RangeOpts): FieldHandle {
  const id = `f${Math.random().toString(36).slice(2, 8)}`;
  const log = o.scale === "log";
  const toPos = (v: number) =>
    log ? (Math.log(v / o.min) / Math.log(o.max / o.min)) * 1000 : v;
  const fromPos = (p: number) =>
    log ? o.min * (o.max / o.min) ** (p / 1000) : p;
  const step = o.step ?? (o.max - o.min > 20 ? 1 : 0.01);
  const digits =
    o.digits ??
    choose(
      [
        [step >= 1, 0],
        [step >= 0.1, 1],
        [step >= 0.01, 2],
      ],
      3
    );
  const range = h("input", {
    id,
    max: log ? 1000 : o.max,
    min: log ? 0 : o.min,
    step: log ? 1 : step,
    type: "range",
    value: toPos(clamp(o.value, o.min, o.max)),
  }) as HTMLInputElement;
  const num = h("input", {
    "aria-label": `${o.label} value`,
    max: o.max,
    min: o.min,
    step,
    type: "number",
  }) as HTMLInputElement;
  // the longest text the box can hold, so the full range always fits
  const chars = Math.min(
    8,
    Math.max(6, o.min.toFixed(digits).length, o.max.toFixed(digits).length)
  );
  num.style.setProperty("--nc", String(chars));
  const lab = h("label", { for: id }, o.label);
  const setP = () => {
    const span = Number(range.max) - Number(range.min);
    range.style.setProperty(
      "--p",
      `${((Number(range.value) - Number(range.min)) / span) * 100}%`
    );
  };
  const show = (v: number) => {
    num.value = fmtNum(v, digits);
    range.value = String(toPos(clamp(v, o.min, o.max)));
    setP();
  };
  show(o.value);
  range.addEventListener("input", () => {
    let v = fromPos(Number(range.value));
    if (step >= 1 || log) {
      v = log ? Math.round(v * 100) / 100 : Math.round(v / step) * step;
    }
    num.value = fmtNum(v, digits);
    setP();
    o.onInput(v);
  });
  num.addEventListener("change", () => {
    const v = clamp(Number(num.value) || 0, o.min, o.max);
    show(v);
    o.onInput(v);
  });
  num.addEventListener("keydown", (e) => e.stopPropagation());
  const row = h("div", { class: "fld" }, lab, range, num);
  if (o.title) {
    lab.title = o.title;
  }
  body.append(row);
  const setOff = mark([range, num], [lab, range, num]);
  setOff(o.off ?? false);
  return { el: [lab, range, num], set: show, setOff };
}

export interface SelectOpts<T extends string> {
  label: string;
  off?: string | false;
  onInput: (v: T) => void;
  options: readonly (T | { value: T; label: string; disabled?: boolean })[];
  value: T;
}

export function selectField<T extends string>(
  body: HTMLElement,
  o: SelectOpts<T>
): FieldHandle & { select: HTMLSelectElement } {
  const id = `f${Math.random().toString(36).slice(2, 8)}`;
  const sel = h("select", { class: "wide", id }) as HTMLSelectElement;
  for (const opt of o.options) {
    const v = typeof opt === "string" ? opt : opt.value;
    const label = typeof opt === "string" ? opt : opt.label;
    const option = h("option", { value: v }, label);
    if (typeof opt !== "string" && opt.disabled) {
      option.disabled = true;
    }
    sel.append(option);
  }
  sel.value = o.value;
  sel.addEventListener("change", () => o.onInput(sel.value as T));
  const lab = h("label", { for: id }, o.label);
  body.append(h("div", { class: "fld" }, lab, sel));
  const setOff = mark([sel], [lab, sel]);
  setOff(o.off ?? false);
  return {
    el: [lab, sel],
    select: sel,
    set(v) {
      sel.value = String(v);
    },
    setOff,
  };
}

export interface ToggleOpts {
  label: string;
  off?: string | false;
  onInput: (v: boolean) => void;
  value: boolean;
}

export function toggleField(
  body: HTMLElement,
  o: ToggleOpts
): FieldHandle & { input: HTMLInputElement } {
  const id = `f${Math.random().toString(36).slice(2, 8)}`;
  const input = h("input", { id, type: "checkbox" }) as HTMLInputElement;
  input.checked = o.value;
  input.addEventListener("change", () => o.onInput(input.checked));
  const sw = h("span", { class: "tgl wide" }, input, h("span", {}));
  const lab = h("label", { for: id }, o.label);
  body.append(h("div", { class: "fld" }, lab, sw));
  const setOff = mark([input], [lab, sw]);
  setOff(o.off ?? false);
  return {
    el: [lab, sw],
    input,
    set(v) {
      input.checked = !!v;
    },
    setOff,
  };
}

/** A line of plain text inside a group body. */
export function note(body: HTMLElement, text: string): HTMLElement {
  const el = h(
    "div",
    { class: "hint wide", style: "grid-column:1/-1;padding:0" },
    text
  );
  body.append(el);
  return el;
}

export function textField(
  body: HTMLElement,
  o: {
    label: string;
    value: string;
    onInput: (v: string) => void;
    placeholder?: string;
  }
): HTMLInputElement {
  const id = `f${Math.random().toString(36).slice(2, 8)}`;
  const input = h("input", {
    class: "wide",
    id,
    placeholder: o.placeholder ?? "",
    type: "text",
    value: o.value,
  }) as HTMLInputElement;
  input.addEventListener("input", () => o.onInput(input.value));
  input.addEventListener("keydown", (e) => e.stopPropagation());
  body.append(
    h("div", { class: "fld" }, h("label", { for: id }, o.label), input)
  );
  return input;
}

/** The title row at the top of an inspector: a pixel icon and a name. */
export function inspectorTitle(iconName: string, text: string): HTMLElement {
  const title = h("div", { class: "insp-title" });
  title.innerHTML = `${icon(iconName, 16)}<span class="nm"></span>`;
  (title.querySelector(".nm") as HTMLElement).textContent = text;
  return title;
}
