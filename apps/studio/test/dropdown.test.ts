/* The pixel dropdown (src/ui/dropdown.ts) on plain selects: the real select stays the source of truth, so the checks
   are on what code reading `.value` and listening for `change` sees, plus the keyboard contract and the ARIA state.
   The mutation observers run as microtasks, so a test awaits `flush()` after changing a select from outside. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enhanceSelect, installDropdowns } from "../src/ui/dropdown.ts";

const opt = (v: string): HTMLOptionElement => {
  const o = document.createElement("option");
  o.value = v;
  o.textContent = v;
  return o;
};
const flush = () => Promise.resolve().then(() => Promise.resolve());

/** A select with the given options in the document, enhanced; returns it with its button. */
function make(
  values: readonly string[] = ["alpha", "beta", "gamma"],
  attrs: Partial<HTMLSelectElement> = {}
): { button: HTMLButtonElement; select: HTMLSelectElement } {
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Pick");
  for (const v of values) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    select.append(o);
  }
  Object.assign(select, attrs);
  document.body.append(select);
  const button = enhanceSelect(select) as HTMLButtonElement;
  return { button, select };
}

const pop = () => document.querySelector<HTMLElement>(".dd-pop");
const rows = () => [...document.querySelectorAll<HTMLElement>(".dd-opt")];
const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: k,
      ...init,
    })
  );
/** The key goes to whatever has focus, like a real key press. */
const press = (k: string) => key(document.activeElement ?? document.body, k);

beforeEach(() => {
  document.body.replaceChildren();
});
afterEach(() => {
  // close anything a test left open so the next test starts clean
  press("Escape");
  vi.useRealTimers();
});

describe("dropdown", () => {
  it("puts a labelled button before the select and keeps the select as the source of truth", () => {
    const { button, select } = make();
    expect(select.previousElementSibling).toBe(button);
    expect(button.getAttribute("aria-haspopup")).toBe("listbox");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Pick: alpha");
    expect(button.querySelector(".dd-cur")?.textContent).toBe("alpha");
    expect(select.getAttribute("aria-hidden")).toBe("true");
    expect(select.tabIndex).toBe(-1);
  });

  it("enhances a select once, and leaves multiple and data-native ones alone", () => {
    const { button, select } = make();
    expect(enhanceSelect(select)).toBe(button);
    expect(document.querySelectorAll("button.dd")).toHaveLength(1);
    const multi = document.createElement("select");
    multi.multiple = true;
    expect(enhanceSelect(multi)).toBeNull();
    const native = document.createElement("select");
    native.setAttribute("data-native", "");
    expect(enhanceSelect(native)).toBeNull();
  });

  it("follows the select when code sets its value", () => {
    const { button, select } = make();
    select.value = "gamma";
    expect(button.querySelector(".dd-cur")?.textContent).toBe("gamma");
    select.selectedIndex = 1;
    expect(button.getAttribute("aria-label")).toBe("Pick: beta");
  });

  it("opens a listbox with the options and marks the selected one", () => {
    const { button, select } = make();
    select.value = "beta";
    button.click();
    expect(pop()?.getAttribute("role")).toBe("listbox");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(rows().map((r) => r.textContent)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(rows().map((r) => r.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(pop()?.getAttribute("aria-activedescendant")).toBe(rows()[1]?.id);
  });

  it("chooses with the keyboard and fires input and change on the select with the new value", () => {
    const { button, select } = make();
    const seen: string[] = [];
    select.addEventListener("input", () => seen.push(`input:${select.value}`));
    select.addEventListener("change", () =>
      seen.push(`change:${select.value}`)
    );
    button.focus();
    key(button, "ArrowDown");
    expect(pop()).not.toBeNull();
    expect(document.activeElement).toBe(pop());
    press("ArrowDown");
    press("ArrowDown");
    press("Enter");
    expect(seen).toEqual(["input:gamma", "change:gamma"]);
    expect(select.value).toBe("gamma");
    expect(button.querySelector(".dd-cur")?.textContent).toBe("gamma");
    expect(pop()).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("chooses with Space and does not fire change when the value stays", () => {
    const { button, select } = make();
    const change = vi.fn();
    select.addEventListener("change", change);
    button.focus();
    key(button, " ");
    press(" ");
    expect(change).not.toHaveBeenCalled();
    key(button, "ArrowUp");
    press("ArrowDown");
    press(" ");
    expect(change).toHaveBeenCalledTimes(1);
    expect(select.value).toBe("beta");
  });

  it("chooses with a click on an option", () => {
    const { button, select } = make();
    const change = vi.fn();
    select.addEventListener("change", change);
    button.click();
    rows()[2]?.click();
    expect(select.value).toBe("gamma");
    expect(change).toHaveBeenCalledTimes(1);
    expect(pop()).toBeNull();
  });

  it("moves with Home, End and the page keys, and stops at the ends", () => {
    const { button } = make(["a", "b", "c", "d", "e"]);
    button.focus();
    button.click();
    const active = () => rows().findIndex((r) => r.classList.contains("act"));
    press("End");
    expect(active()).toBe(4);
    press("ArrowDown");
    expect(active()).toBe(4);
    press("Home");
    expect(active()).toBe(0);
    press("ArrowUp");
    expect(active()).toBe(0);
    press("PageDown");
    expect(active()).toBeGreaterThan(0);
    press("PageUp");
    expect(active()).toBe(0);
  });

  it("skips disabled options", () => {
    const { button, select } = make(["a", "b", "c"]);
    (select.options[1] as HTMLOptionElement).disabled = true;
    button.click();
    press("ArrowDown");
    press("Enter");
    expect(select.value).toBe("c");
    button.click();
    rows()[1]?.click();
    expect(select.value).toBe("c");
  });

  it("finds options by typing, and starts a new word after a pause", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { button, select } = make(["apple", "banana", "blueberry", "cherry"]);
    button.focus();
    key(button, "b");
    expect(pop()).not.toBeNull();
    expect(rows()[1]?.classList.contains("act")).toBe(true);
    press("l");
    expect(rows()[2]?.classList.contains("act")).toBe(true);
    vi.advanceTimersByTime(1000);
    press("c");
    expect(rows()[3]?.classList.contains("act")).toBe(true);
    press("Enter");
    expect(select.value).toBe("cherry");
  });

  it("cycles through the matches of one repeated letter", () => {
    const { button } = make(["bee", "bat", "cat", "bug"]);
    button.click();
    press("b");
    expect(rows()[1]?.classList.contains("act")).toBe(true);
    press("b");
    expect(rows()[3]?.classList.contains("act")).toBe(true);
    press("b");
    expect(rows()[0]?.classList.contains("act")).toBe(true);
  });

  it("closes on Escape and gives focus back to the button", () => {
    const { button, select } = make();
    button.focus();
    button.click();
    expect(document.activeElement).toBe(pop());
    const esc = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    const reached = vi.fn();
    document.addEventListener("keydown", reached);
    document.activeElement?.dispatchEvent(esc);
    document.removeEventListener("keydown", reached);
    expect(pop()).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(select.value).toBe("alpha");
    // nothing else (a dialog that closes on Escape, a global shortcut) saw the key
    expect(reached).not.toHaveBeenCalled();
  });

  it("closes on Tab without choosing, and keeps the browser's own Tab move", () => {
    const { button, select } = make();
    button.click();
    press("ArrowDown");
    const tab = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
    });
    document.activeElement?.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(pop()).toBeNull();
    expect(select.value).toBe("alpha");
    expect(document.activeElement).toBe(button);
  });

  it("closes when the pointer goes down elsewhere, without taking focus back", () => {
    const { button } = make();
    const other = document.createElement("input");
    document.body.append(other);
    button.click();
    other.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(pop()).toBeNull();
    other.focus();
    expect(document.activeElement).toBe(other);
  });

  it("toggles closed when the button is clicked again", () => {
    const { button } = make();
    button.click();
    expect(pop()).not.toBeNull();
    button.click();
    expect(pop()).toBeNull();
  });

  it("opens one list at a time", () => {
    const a = make();
    const b = make();
    a.button.click();
    b.button.click();
    expect(document.querySelectorAll(".dd-pop")).toHaveLength(1);
    expect(a.button.getAttribute("aria-expanded")).toBe("false");
    expect(b.button.getAttribute("aria-expanded")).toBe("true");
  });

  it("cannot be opened while disabled, and follows enabling and disabling", async () => {
    const { button, select } = make(["a", "b"], { disabled: true });
    await flush();
    expect(button.disabled).toBe(true);
    button.click();
    key(button, "ArrowDown");
    key(button, "a");
    expect(pop()).toBeNull();
    select.disabled = false;
    await flush();
    expect(button.disabled).toBe(false);
    button.click();
    expect(pop()).not.toBeNull();
    select.disabled = true;
    await flush();
    expect(pop()).toBeNull();
    expect(button.disabled).toBe(true);
  });

  it("shows options that are replaced later, closed and open", async () => {
    const { button, select } = make(["old"]);
    select.replaceChildren(
      ...["one", "two", "three"].map((v) => {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = `Model ${v}`;
        return o;
      })
    );
    select.value = "two";
    await flush();
    expect(button.querySelector(".dd-cur")?.textContent).toBe("Model two");
    button.click();
    expect(rows().map((r) => r.textContent)).toEqual([
      "Model one",
      "Model two",
      "Model three",
    ]);
    // replaced again while the list is open
    const extra = document.createElement("option");
    extra.value = "four";
    extra.textContent = "Model four";
    select.append(extra);
    await flush();
    expect(rows()).toHaveLength(4);
    press("End");
    press("Enter");
    expect(select.value).toBe("four");
  });

  it("mirrors the select's classes, title and hidden state onto the button", async () => {
    const { button, select } = make();
    select.className = "wide off";
    select.title = "Not for this wave";
    select.hidden = true;
    await flush();
    expect(button.classList.contains("dd")).toBe(true);
    expect(button.classList.contains("wide")).toBe(true);
    expect(button.classList.contains("off")).toBe(true);
    expect(button.classList.contains("dd-native")).toBe(false);
    expect(button.title).toBe("Not for this wave");
    expect(button.hidden).toBe(true);
  });

  it("sends focus aimed at the select to the button", () => {
    const { button, select } = make();
    select.focus();
    expect(document.activeElement).toBe(button);
  });

  it("names the button from a label that points at the select", () => {
    const select = document.createElement("select");
    select.id = "sel-x";
    select.append(opt("one"));
    const label = document.createElement("label");
    label.htmlFor = "sel-x";
    label.textContent = "Wave";
    document.body.append(label, select);
    const button = enhanceSelect(select) as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe("Wave: one");
  });

  it("installDropdowns enhances selects present and added later, and drops the button with a removed select", async () => {
    const early = document.createElement("select");
    early.append(opt("x"));
    document.body.append(early);
    const stop = installDropdowns();
    expect(early.previousElementSibling?.classList.contains("dd")).toBe(true);
    const row = document.createElement("div");
    const late = document.createElement("select");
    late.append(opt("y"), opt("z"));
    row.append(late);
    document.body.append(row);
    await flush();
    expect(late.previousElementSibling?.classList.contains("dd")).toBe(true);
    late.remove();
    await flush();
    expect(row.querySelector("button.dd")).toBeNull();
    row.append(late);
    await flush();
    expect(row.querySelectorAll("button.dd")).toHaveLength(1);
    stop();
  });
});
