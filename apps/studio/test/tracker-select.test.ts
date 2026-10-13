/* Block selection in the tracker (Shift and the arrow keys, the mouse, copy, cut, paste, clear, transpose, one undo step
   each) and the places Duplicate and Delete live: the bottom of every inspector and the sidebar's context menu. The shell
   is real, on the fake engine and a browser store; every test drives the real controls. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Row, Song } from "../src/lib/contract.ts";
import { defaultSong } from "../src/lib/core.ts";
import { clearClipboard } from "../src/lib/tracker-clipboard.ts";
import { installCanvasStub, settle, until } from "./helpers.ts";

installCanvasStub();
vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

type AppMod = typeof import("../src/app.ts");
type DocsMod = typeof import("../src/state/docs.ts");

let appMod: AppMod;
let docsMod: DocsMod;

const project = () => docsMod.project;
const songValue = (id: string) => project().get("song", id)?.value as Song;
const press = (el: Element | null) => {
  expect(el).not.toBeNull();
  (el as HTMLElement).click();
};
const tracker = () => document.getElementById("gTracker") as HTMLElement;
const key = (k: string, init: KeyboardEventInit = {}, el?: Element) =>
  (el ?? tracker()).dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: k,
      ...init,
    })
  );
const ctrl = (k: string, init: KeyboardEventInit = {}) =>
  key(k, { ctrlKey: true, ...init });
const shift = (k: string) => key(k, { shiftKey: true });
const keys = (...ks: string[]) => {
  for (const k of ks) {
    key(k);
  }
};
const cellAt = (row: number, ch: number) =>
  document.querySelector(
    `.trow[data-r="${row}"] .tc[data-ch="${ch}"]`
  ) as HTMLElement;
const pointer = (type: string, el: Element, init: PointerEventInit = {}) =>
  el.dispatchEvent(
    new PointerEvent(type, { bubbles: true, button: 0, ...init })
  );
/** The cells that carry the selection highlight, as "row:channel". */
const selected = () =>
  [...document.querySelectorAll<HTMLElement>(".tr-body .tc.blk")].map(
    (el) => `${el.closest<HTMLElement>(".trow")?.dataset.r}:${el.dataset.ch}`
  );
const cursorRow = () =>
  Number(
    document.querySelector(".tr-body .tc .cur")?.closest<HTMLElement>(".trow")
      ?.dataset.r
  );
const toast = () => {
  const el = document.getElementById("toast") as HTMLElement;
  return el.hidden ? "" : (el.querySelector("span")?.textContent ?? "");
};

const go = async (hash: string, ready: () => boolean) => {
  appMod.app.navigate(hash);
  expect(await until(ready, 6000)).toBe(true);
  await settle(30);
};
const goSong = (id: string) =>
  go(`#/song/${id}`, () => document.querySelectorAll(".trow").length >= 8);
/** Mount the song editor afresh (the same hash would not remount it): cursor at the top left, nothing selected. */
const openSong = async (id: string) => {
  await go("#/pads", () => document.querySelector(".pad[data-id]") !== null);
  await goSong(id);
};
const lowestNote = () =>
  (Number(document.getElementById("gOct")?.textContent) + 1) * 12;
const goSfx = (id: string) =>
  go(`#/sfx/${id}`, () => document.querySelector("#sName") !== null);
const goInstrument = (id: string) =>
  go(`#/instrument/${id}`, () => document.getElementById("iKeys") !== null);

beforeAll(async () => {
  vi.stubGlobal("confirm", () => true);
  (
    window as unknown as { happyDOM?: { setURL: (url: string) => void } }
  ).happyDOM?.setURL("http://localhost:3000/?engine=fake&store=local#/pads");
  document.body.innerHTML =
    '<canvas id="backdrop"></canvas><div id="app"></div>';
  appMod = await import("../src/app.ts");
  docsMod = await import("../src/state/docs.ts");
  const { boot } = await import("../src/shell.ts");
  await boot(document.getElementById("app") as HTMLElement);
  await until(() => document.querySelectorAll(".tree-item").length > 0);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

/** A song of the project's chip: one pattern of 8 rows. */
const makeSong = async (id: string, name = id) => {
  const song = defaultSong(project().project.chip);
  song.name = name;
  song.patterns = { "pattern-1": { length: 8, tracks: {} } };
  song.order = ["pattern-1"];
  await project().create("song", id, song);
};
const rowsOf = (id: string, ch = 0): [number, Row["note"]][] => {
  const s = songValue(id);
  const rows = s.patterns["pattern-1"]?.tracks[s.channels[ch]?.id as string];
  return (rows ?? []).map((r) => [r.row, r.note]);
};

describe("selecting, copying and pasting in the tracker", () => {
  const ID = "select-song";
  const doc = () => project().get("song", ID) as never;
  beforeAll(async () => {
    await makeSong(ID);
  });

  it("Shift and the arrow keys select whole cells, Escape and a plain move clear the selection", async () => {
    await openSong(ID);
    keys("z", "x", "c", "v");
    expect(rowsOf(ID)).toHaveLength(4);
    keys("Home");
    shift("ArrowDown");
    shift("ArrowDown");
    expect(selected()).toEqual(["0:0", "1:0", "2:0"]);
    expect(cursorRow()).toBe(2);
    shift("ArrowRight");
    expect(selected()).toHaveLength(6);
    shift("ArrowUp");
    expect(selected()).toEqual(["0:0", "0:1", "1:0", "1:1"]);
    shift("End");
    expect(selected()).toHaveLength(16);
    shift("Home");
    expect(selected()).toEqual(["0:0", "0:1"]);
    key("Escape");
    expect(selected()).toEqual([]);
    shift("PageDown");
    expect(selected()).toHaveLength(8);
    keys("ArrowDown");
    expect(selected()).toEqual([]);
  });

  it("Copy then Paste puts the block at the cursor, as one undo step", async () => {
    await openSong(ID);
    const before = rowsOf(ID);
    keys("Home");
    shift("ArrowDown");
    ctrl("c");
    keys("ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown");
    expect(cursorRow()).toBe(5);
    ctrl("v");
    const notes = rowsOf(ID);
    expect(notes.filter(([r]) => r >= 5)).toEqual([
      [5, before[0]?.[1]],
      [6, before[1]?.[1]],
    ]);
    // what was on those rows is gone, the rows around are not
    expect(notes.filter(([r]) => r < 4)).toEqual(before.slice(0, 4));
    // the pasted cells are selected
    expect(selected()).toEqual(["5:0", "6:0"]);
    expect(project().undo(doc())).toBe(true);
    expect(rowsOf(ID)).toEqual(before);
  });

  it("Delete clears the selected cells in one undo step, and Cut takes them to the clipboard", async () => {
    await openSong(ID);
    const before = rowsOf(ID);
    keys("Home");
    shift("ArrowDown");
    shift("ArrowDown");
    keys("Delete");
    expect(rowsOf(ID)).toEqual(before.filter(([r]) => r > 2));
    expect(project().undo(doc())).toBe(true);
    expect(rowsOf(ID)).toEqual(before);
    // cut = copy + clear; pasting it further down brings the notes back there
    key("Home");
    shift("ArrowDown");
    ctrl("x");
    expect(rowsOf(ID).filter(([r]) => r < 2)).toEqual([]);
    keys("ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown");
    ctrl("v");
    expect(rowsOf(ID).map(([r]) => r)).toEqual([2, 3, 6, 7]);
    project().undo(doc());
    project().undo(doc());
    expect(rowsOf(ID)).toEqual(before);
  });

  it("without a selection copy and cut take the cell under the cursor", async () => {
    await openSong(ID);
    const before = rowsOf(ID);
    keys("Home");
    ctrl("c");
    keys(
      "ArrowDown",
      "ArrowDown",
      "ArrowDown",
      "ArrowDown",
      "ArrowDown",
      "ArrowDown",
      "ArrowDown"
    );
    ctrl("v");
    expect(rowsOf(ID).find(([r]) => r === 7)?.[1]).toBe(before[0]?.[1]);
    project().undo(doc());
  });

  it("Ctrl A selects the channel, then the whole pattern", async () => {
    await openSong(ID);
    keys("Home");
    ctrl("a");
    expect(selected()).toHaveLength(8);
    expect(new Set(selected().map((s) => s.split(":")[1]))).toEqual(
      new Set(["0"])
    );
    ctrl("a");
    expect(selected()).toHaveLength(8 * songValue(ID).channels.length);
    key("Escape");
    expect(selected()).toEqual([]);
  });

  it("Ctrl Up and Ctrl Down transpose the selected notes, Shift makes it an octave, each one undo step", async () => {
    await openSong(ID);
    const before = rowsOf(ID);
    keys("Home");
    shift("ArrowDown");
    ctrl("ArrowUp");
    expect(
      rowsOf(ID)
        .slice(0, 2)
        .map(([, n]) => n)
    ).toEqual(before.slice(0, 2).map(([, n]) => (n as number) + 1));
    ctrl("ArrowDown", { shiftKey: true });
    expect(rowsOf(ID)[0]?.[1]).toBe((before[0]?.[1] as number) - 11);
    project().undo(doc());
    project().undo(doc());
    expect(rowsOf(ID)).toEqual(before);
  });

  it("dragging across cells and Shift click select with the mouse", async () => {
    await openSong(ID);
    pointer("pointerdown", cellAt(1, 0).querySelector("[data-f]") as Element);
    expect(selected()).toEqual([]);
    pointer("pointermove", cellAt(3, 1), { buttons: 1 });
    expect(selected()).toEqual(["1:0", "1:1", "2:0", "2:1", "3:0", "3:1"]);
    expect(cursorRow()).toBe(3);
    pointer("pointerup", document.body);
    pointer("pointermove", cellAt(6, 1), { buttons: 1 });
    expect(selected()).toHaveLength(6);
    pointer("pointerdown", cellAt(5, 0).querySelector("[data-f]") as Element);
    expect(selected()).toEqual([]);
    pointer("pointerdown", cellAt(7, 0).querySelector("[data-f]") as Element, {
      shiftKey: true,
    });
    expect(selected()).toEqual(["5:0", "6:0", "7:0"]);
    pointer("pointerup", document.body);
  });

  it("pastes text from the system clipboard when it is newer than the copy, and keeps typing and undo working", async () => {
    await openSong(ID);
    clearClipboard();
    keys("Home");
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(paste, {
      clipboardData: { getData: () => "G-4 -- - ---\nA-4 -- - ---" },
    });
    tracker().dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    const at = (r: number) => rowsOf(ID).find(([row]) => row === r)?.[1];
    expect(at(0)).toBe(67);
    expect(at(1)).toBe(69);
    // text that is not a block is left to the browser
    const other = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(other, { clipboardData: { getData: () => "hello" } });
    clearClipboard();
    tracker().dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
    // typing a note still writes the cell and moves down; Ctrl Z is the document's
    const old = at(2);
    keys("Escape", "ArrowDown", "ArrowDown", "z");
    expect(at(2)).toBe(lowestNote());
    expect(project().undo(doc())).toBe(true);
    expect(at(2)).toBe(old);
    project().undo(doc());
    expect(at(0)).not.toBe(67);
  });

  it("the keys do nothing while focus is in a text field outside the grid", async () => {
    await openSong(ID);
    const before = JSON.stringify(songValue(ID));
    const tempo = document.getElementById("gTempo") as HTMLInputElement;
    for (const k of ["a", "c", "x", "v", "ArrowDown"]) {
      key(k, { ctrlKey: true }, tempo);
    }
    key("ArrowDown", { shiftKey: true }, tempo);
    key("Delete", {}, tempo);
    expect(selected()).toEqual([]);
    expect(JSON.stringify(songValue(ID))).toBe(before);
  });

  it("existing keys still work: Ctrl Z undoes, F toggles follow, Tab moves to the next channel", async () => {
    await openSong(ID);
    keys(
      "Home",
      "ArrowDown",
      "ArrowDown",
      "ArrowDown",
      "ArrowDown",
      "ArrowDown",
      "z"
    );
    expect(rowsOf(ID).some(([r]) => r === 5)).toBe(true);
    ctrl("z");
    expect(rowsOf(ID).some(([r]) => r === 5)).toBe(false);
    const follow = document.getElementById("gFollow") as HTMLInputElement;
    const was = follow.checked;
    keys("f");
    expect(follow.checked).toBe(!was);
    keys("f");
    keys("Tab");
    expect(
      document.querySelector(".tr-body .tc .cur")?.closest<HTMLElement>(".tc")
        ?.dataset.ch
    ).toBe("1");
  });
});

describe("Duplicate and Delete", () => {
  const buttons = () =>
    [...document.querySelectorAll<HTMLElement>("#insp .insp-danger .btn")].map(
      (b) => b.textContent
    );

  it("the sound effect inspector ends with Duplicate and Delete sound effect, and Duplicate opens the copy", async () => {
    const first = project().list("sfx")[0] as { id: string; value: unknown };
    const { id } = first;
    const count = project().list("sfx").length;
    await goSfx(id);
    expect(buttons()).toEqual(["Duplicate", "Delete sound effect"]);
    press(document.querySelector("#insp .insp-danger .btn"));
    expect(await until(() => project().list("sfx").length === count + 1)).toBe(
      true
    );
    const copy = project().get("sfx", `${id}-copy`);
    expect(copy).toBeDefined();
    expect(await until(() => location.hash === `#/sfx/${id}-copy`)).toBe(true);
    expect(toast()).toContain("Duplicated as");
    expect(((copy as { value: unknown }).value as { name: string }).name).toBe(
      `${(first.value as { name: string }).name} copy`
    );
  });

  it("the song inspector has the pair too, and duplicating names the copy and leaves the original", async () => {
    await makeSong("dup-song", "Dup song");
    await goSong("dup-song");
    expect(buttons()).toEqual(["Duplicate", "Delete song"]);
    press(document.querySelector("#insp .insp-danger .btn"));
    expect(await until(() => !!project().get("song", "dup-song-copy"))).toBe(
      true
    );
    expect(songValue("dup-song-copy").name).toBe("Dup song copy");
    expect(songValue("dup-song").name).toBe("Dup song");
    // a second copy gets its own id and name
    const second = await project().duplicate(
      project().get("song", "dup-song") as never
    );
    expect(second.id).toBe("dup-song-copy-2");
    expect((second.value as Song).name).toBe("Dup song copy 2");
  });

  it("a copied instrument is a new document: songs that use the original keep it", async () => {
    const [inst] = project().list("instrument");
    const id = inst?.id as string;
    await makeSong("uses-inst", "Uses inst");
    await project().edit<Song>(
      project().get("song", "uses-inst") as never,
      (s) => {
        const [ch] = s.channels;
        if (ch) {
          ch.instrument = id;
        }
      }
    );
    const before = JSON.stringify(songValue("uses-inst"));
    await goInstrument(id);
    expect(buttons()).toEqual(["Duplicate", "Delete instrument"]);
    press(document.querySelector("#insp .insp-danger .btn"));
    expect(await until(() => !!project().get("instrument", `${id}-copy`))).toBe(
      true
    );
    expect(JSON.stringify(songValue("uses-inst"))).toBe(before);
    expect(songValue("uses-inst").channels[0]?.instrument).toBe(id);
  });
});

describe("the sidebar context menu", () => {
  const row = (kind: string, id: string) =>
    document.querySelector(
      `.tree-item[data-kind="${kind}"][data-id="${id}"]`
    ) as HTMLElement;
  const menu = () => document.querySelector(".cm-pop") as HTMLElement | null;
  const items = () =>
    [...(menu()?.querySelectorAll(".cm-opt") ?? [])].map(
      (el) => el.textContent
    );
  const contextmenu = (el: Element, x = 40, y = 60) =>
    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      })
    );

  it("a right click on a sound opens Open, Duplicate, Open in analysis and Delete", async () => {
    await go("#/pads", () => document.querySelector(".pad[data-id]") !== null);
    const [first] = project().list("sfx");
    const id = first?.id as string;
    const ev = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 60,
    });
    row("sfx", id).querySelector("a.tl")?.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(items()).toEqual([
      "Open",
      "Duplicate",
      "Open in analysis",
      "Delete",
    ]);
    expect(menu()?.getAttribute("role")).toBe("menu");
    // Escape closes it
    key("Escape", {}, menu() as Element);
    expect(menu()).toBeNull();
  });

  it("Duplicate in the menu makes the copy; instruments and samples have no analysis entry", async () => {
    const [first] = project().list("sfx");
    const id = first?.id as string;
    const copies = () =>
      project()
        .list("sfx")
        .filter((d) => d.id.startsWith(`${id}-copy`)).length;
    const before = copies();
    contextmenu(row("sfx", id));
    const dup = [...document.querySelectorAll<HTMLElement>(".cm-opt")].find(
      (el) => el.textContent === "Duplicate"
    );
    press(dup ?? null);
    expect(menu()).toBeNull();
    expect(await until(() => copies() === before + 1)).toBe(true);
    const [inst] = project().list("instrument");
    contextmenu(row("instrument", inst?.id as string));
    expect(items()).toEqual(["Open", "Duplicate", "Delete"]);
    key("Escape", {}, menu() as Element);
  });

  it("the ContextMenu key and Shift F10 open it on a focused item; arrows move, Enter picks, outside click and scroll close", async () => {
    await makeSong("menu-song", "Menu song");
    await go("#/pads", () => document.querySelector(".pad[data-id]") !== null);
    await until(() => row("song", "menu-song") !== null);
    const link = row("song", "menu-song").querySelector("a.tl") as HTMLElement;
    link.focus();
    key("ContextMenu", {}, link);
    expect(items()).toEqual([
      "Open",
      "Duplicate",
      "Open in analysis",
      "Delete",
    ]);
    expect(menu()?.querySelector(".act")?.textContent).toBe("Open");
    key("ArrowDown", {}, menu() as Element);
    expect(menu()?.querySelector(".act")?.textContent).toBe("Duplicate");
    key("Enter", {}, menu() as Element);
    expect(menu()).toBeNull();
    expect(await until(() => !!project().get("song", "menu-song-copy"))).toBe(
      true
    );
    await go("#/pads", () => document.querySelector(".pad[data-id]") !== null);
    const again = row("song", "menu-song").querySelector("a.tl") as HTMLElement;
    key("F10", { shiftKey: true }, again);
    expect(menu()).not.toBeNull();
    key("ArrowUp", {}, menu() as Element);
    expect(menu()?.querySelector(".act")?.textContent).toBe("Delete");
    pointer("pointerdown", document.body);
    expect(menu()).toBeNull();
    key("ContextMenu", {}, again);
    expect(menu()).not.toBeNull();
    window.dispatchEvent(new Event("scroll"));
    expect(menu()).toBeNull();
  });

  it("Delete in the menu asks first", async () => {
    await go("#/pads", () => document.querySelector(".pad[data-id]") !== null);
    contextmenu(row("song", "menu-song"));
    const del = [...document.querySelectorAll<HTMLElement>(".cm-opt")].find(
      (el) => el.textContent === "Delete"
    );
    press(del ?? null);
    expect(await until(() => document.querySelector(".confirm") !== null)).toBe(
      true
    );
    expect(document.querySelector(".confirm")?.textContent).toContain(
      "Delete the song"
    );
    press(document.querySelector(".confirm-btns .btn.primary"));
    expect(await until(() => !project().get("song", "menu-song"), 4000)).toBe(
      true
    );
  });
});
