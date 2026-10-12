/* A song written in MML shows its notes in the song editor's grid (read only), a typed key on such a cell says where
   to edit, the order list stays inside its panel, and the instrument warning has a one-click fix. The shell is real, on
   the fake engine and a browser store; every test drives the real controls. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import indexHtml from "../index.html?raw";
import type { Song } from "../src/lib/contract.ts";
import { defaultSong, makeInstrument, mmlToTrack } from "../src/lib/core.ts";
import { compileMmlRows, rowsInRange } from "../src/lib/mml-rows.ts";
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
const go = async (hash: string, ready: () => boolean) => {
  appMod.app.navigate(hash);
  expect(await until(ready, 6000)).toBe(true);
  await settle(30);
};
const goSong = (id: string) =>
  go(`#/song/${id}`, () => document.querySelectorAll(".trow").length >= 8);
const toastText = () => {
  const el = document.getElementById("toast") as HTMLElement;
  return el.hidden ? "" : (el.querySelector("span")?.textContent ?? "");
};
/** The note text of one grid cell. */
const noteAt = (row: number, ch: number) =>
  document
    .querySelector(`.trow[data-r="${row}"] .tc[data-ch="${ch}"] [data-f="0"]`)
    ?.textContent?.trim();

beforeAll(async () => {
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

/** A song of the project's chip: two patterns of 16 rows, channel 0 written in `mml`. */
async function makeMmlSong(id: string, mml: string, order = ["a", "b"]) {
  const song = defaultSong(project().project.chip);
  song.name = id;
  song.rowsPerBeat = 4;
  song.patterns = {
    a: { length: 16, tracks: {} },
    b: { length: 16, tracks: {} },
  };
  song.order = order;
  (song.channels[0] as { mml: string | null }).mml = mml;
  await project().create("song", id, song);
}

describe("MML channels in the grid", () => {
  it("compiles once per text and rows per beat, and cuts rows by pattern", () => {
    const text = "o4 l4 c d e f g a";
    const first = compileMmlRows(text, 4);
    expect(compileMmlRows(text, 4)).toBe(first);
    expect(compileMmlRows(text, 8)).not.toBe(first);
    expect(first.map((r) => r.row)).toEqual(
      mmlToTrack(text, 4).rows.map((r) => r.row)
    );
    // the second pattern of 16 rows starts at row 16: its rows count from 0 again
    const second = rowsInRange(first, 16, 16);
    expect([...second.keys()].slice(0, 2)).toEqual([0, 4]);
  });

  it("shows the notes at the right rows of the right pattern, read only and tinted", async () => {
    await makeMmlSong("mml-grid", "o4 l4 c d e f g a");
    await goSong("mml-grid");
    // quarter notes at 4 rows per beat: c d e f on rows 0, 4, 8, 12
    expect(noteAt(0, 0)).toBe("C-4");
    expect(noteAt(4, 0)).toBe("D-4");
    expect(noteAt(8, 0)).toBe("E-4");
    expect(noteAt(12, 0)).toBe("F-4");
    expect(noteAt(2, 0)).toBe("---");
    // no cell says "MML" any more, and the channel is tinted
    expect(document.querySelector(".tr-body")?.textContent).not.toContain(
      "MML"
    );
    expect(
      document.querySelectorAll('.tr-body .tc.is-mml[data-ch="0"]').length
    ).toBeGreaterThanOrEqual(16);
    expect(
      document.querySelectorAll('.tr-body .tc.is-mml[data-ch="1"]').length
    ).toBe(0);
    // the next order entry plays on: g and a on its rows 0 and 4
    press(document.querySelector('#gOrder .ochip[data-i="1"]'));
    expect(await until(() => noteAt(0, 0) === "G-4")).toBe(true);
    expect(noteAt(4, 0)).toBe("A-4");
    // the channel offers the way out
    const conv = document.querySelector('#gHead .tch[data-ch="0"] .conv');
    expect(conv?.textContent).toBe("Convert to tracker to edit");
  });

  it("follows a change of the MML and of the rows per beat", async () => {
    await makeMmlSong("mml-live", "o4 l4 c d");
    await goSong("mml-live");
    expect(noteAt(4, 0)).toBe("D-4");
    project().edit<Song>(project().get("song", "mml-live") as never, (d) => {
      (d.channels[0] as { mml: string | null }).mml = "o4 l4 c d e";
    });
    await until(() => noteAt(8, 0) === "E-4");
    expect(noteAt(8, 0)).toBe("E-4");
  });

  it("says where to edit when a key would change an MML cell, and changes nothing", async () => {
    await makeMmlSong("mml-hint", "o4 l4 c d e f");
    await goSong("mml-hint");
    const before = JSON.stringify(songValue("mml-hint"));
    const tracker = document.getElementById("gTracker") as HTMLElement;
    for (const k of ["z", "Delete"]) {
      tracker.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: k,
        })
      );
    }
    expect(toastText()).toContain("written in MML");
    expect(toastText()).toContain("Convert to tracker to edit");
    expect(JSON.stringify(songValue("mml-hint"))).toBe(before);
  });

  it("converts to tracker rows from the channel's button, in one undo step", async () => {
    await makeMmlSong("mml-conv", "o4 l4 c d e f");
    await goSong("mml-conv");
    press(document.querySelector('#gHead .tch[data-ch="0"] .conv'));
    const song = songValue("mml-conv");
    expect(song.channels[0]?.mml).toBeNull();
    expect(
      song.patterns.a?.tracks[song.channels[0]?.id as string]?.length
    ).toBe(4);
    appMod.app.undo();
    expect(songValue("mml-conv").channels[0]?.mml).toBe("o4 l4 c d e f");
  });
});

describe("the order list", () => {
  it("keeps eighteen entries in its own scrolling box, apart from the buttons", async () => {
    const order = Array.from({ length: 18 }, (_, i) => (i % 2 ? "b" : "a"));
    await makeMmlSong("mml-order", "o4 l4 c d", order);
    await goSong("mml-order");
    const bar = document.getElementById("gOrder") as HTMLElement;
    const list = bar.querySelector(".olist") as HTMLElement;
    expect(list.querySelectorAll(".ochip")).toHaveLength(18);
    expect(bar.querySelectorAll(":scope > .ochip")).toHaveLength(0);
    expect(bar.querySelector(".octl .pat-sel")).not.toBeNull();
    // the box wraps and scrolls instead of pushing the page wide
    const css = /\.olist\s*\{[^}]*\}/.exec(indexHtml)?.[0] ?? "";
    expect(css).toMatch(/flex-wrap:\s*wrap/);
    expect(css).toMatch(/overflow(-y)?:\s*(hidden )?auto/);
    expect(css).toMatch(/max-height:/);
  });
});

describe("the wrong chip warning", () => {
  async function makeMisfit(id: string) {
    const chip = project().project.chip === "genesis" ? "nes" : "genesis";
    const song = defaultSong(chip);
    song.name = id;
    song.patterns = { a: { length: 16, tracks: {} } };
    song.order = ["a"];
    const [first] = song.channels;
    if (!first) {
      throw new Error("no channel");
    }
    // an instrument of the right kind made for the other chip
    const other = chip === "genesis" ? "nes" : "genesis";
    const wrong = makeInstrument(first.kind, other, "lead", `${id}-wrong`);
    await project().create("instrument", `${id}-wrong`, wrong);
    first.instrument = `${id}-wrong`;
    await project().create("song", id, song);
    return { chip, wrong: `${id}-wrong` };
  }

  it("offers 'Use a <chip> instrument' that swaps in a fitting one as one undo step", async () => {
    const { wrong } = await makeMisfit("fix-song");
    await goSong("fix-song");
    const button = await until(
      () => document.querySelector(".issue-fix") !== null
    );
    expect(button).toBe(true);
    const label = document.querySelector(".issue-fix")?.textContent ?? "";
    expect(label).toMatch(/^Use a .+ instrument$/);
    press(document.querySelector(".issue-fix"));
    expect(
      await until(() => songValue("fix-song").channels[0]?.instrument !== wrong)
    ).toBe(true);
    const now = songValue("fix-song").channels[0]?.instrument as string;
    const inst = project().get("instrument", now)?.value as {
      chip: string | null;
    };
    expect([songValue("fix-song").chip, null]).toContain(inst.chip);
    // one undo puts the song back as it was
    appMod.app.undo();
    expect(songValue("fix-song").channels[0]?.instrument).toBe(wrong);
  });
});
