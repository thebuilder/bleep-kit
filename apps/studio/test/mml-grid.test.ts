/* One song, two views: a song that arrives with MML opens as tracker patterns (editable everywhere, no extra undo
   step), the Text view of a channel follows the grid and the grid follows what is typed, and a channel whose timing
   falls between rows stays MML with its text open. The shell is real, on the fake engine and a browser store; every test
   drives the real controls. */
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

/** The note column of channel 0 in the pattern, as MIDI numbers (row -> note). */
const notesOf = (id: string, pattern: string, ch = 0) => {
  const s = songValue(id);
  return (s.patterns[pattern]?.tracks[s.channels[ch]?.id as string] ?? []).map(
    (r) => `${r.row}:${r.note}`
  );
};
const fire = (el: Element, type: string) =>
  el.dispatchEvent(new Event(type, { bubbles: true }));
const textArea = (ch: string) =>
  document.querySelector<HTMLTextAreaElement>(
    `.mml-ta[aria-label$="of ${ch}"]`
  );
const headBtn = (ci: number, act: string) =>
  document.querySelector(`#gHead .tch[data-ch="${ci}"] [data-act="${act}"]`);

describe("a song with MML opens as patterns", () => {
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

  it("has no MML channel, every cell editable, no convert button, and nothing to undo", async () => {
    await makeMmlSong("mml-grid", "o4 l4 c d e f g a");
    const doc = project().get("song", "mml-grid");
    expect(doc?.history.canUndo).toBe(false);
    expect(songValue("mml-grid").channels.every((c) => c.mml === null)).toBe(
      true
    );
    await goSong("mml-grid");
    // quarter notes at 4 rows per beat: c d e f on rows 0, 4, 8, 12
    expect(noteAt(0, 0)).toBe("C-4");
    expect(noteAt(4, 0)).toBe("D-4");
    expect(noteAt(12, 0)).toBe("F-4");
    expect(noteAt(2, 0)).toBe("---");
    expect(document.querySelectorAll(".tr-body .tc.is-mml")).toHaveLength(0);
    expect(document.querySelector("#gHead .conv")).toBeNull();
    expect(document.querySelector("#gHead [data-act='mml']")).toBeNull();
    expect(document.querySelector(".mml-ta")).toBeNull();
    // the next order entry plays on: g and a on its rows 0 and 4
    press(document.querySelector('#gOrder .ochip[data-i="1"]'));
    expect(await until(() => noteAt(0, 0) === "G-4")).toBe(true);
    expect(noteAt(4, 0)).toBe("A-4");
    // opening it left no step to undo, and a typed note is an ordinary edit on the first channel
    expect(doc?.history.canUndo).toBe(false);
    const tracker = document.getElementById("gTracker") as HTMLElement;
    tracker.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Delete" })
    );
    expect(toastText()).not.toContain("MML");
  });

  it("converts a song that changes underneath it, without an undo step to the MML", async () => {
    await makeMmlSong("mml-live", "o4 l4 c d");
    await goSong("mml-live");
    expect(noteAt(4, 0)).toBe("D-4");
    const doc = project().get("song", "mml-live") as never;
    // the CLI or the assistant writes the song with MML text in a channel
    const raw = JSON.parse(JSON.stringify(songValue("mml-live"))) as Song;
    (raw.channels[0] as { mml: string | null }).mml = "o4 l4 c d e";
    project().edit<Song>(doc, () => raw);
    expect(await until(() => noteAt(8, 0) === "E-4")).toBe(true);
    expect(songValue("mml-live").channels[0]?.mml).toBeNull();
    appMod.app.undo();
    await settle(30);
    expect(songValue("mml-live").channels[0]?.mml).toBeNull();
  });
});

describe("the Text view", () => {
  it("is collapsed until the channel's TXT button opens it, and follows the grid", async () => {
    await makeMmlSong("mml-text", "o4 l4 c d e f g a");
    await goSong("mml-text");
    expect(textArea("pulse1")).toBeNull();
    press(headBtn(0, "text"));
    const ta = textArea(songValue("mml-text").channels[0]?.id as string);
    expect(ta).not.toBeNull();
    expect(ta?.value).toContain("c4");
    expect(document.querySelector(".mml-top b")?.textContent).toContain(
      "in pattern a"
    );
    // a note typed into the grid shows up in the text (the box is not focused)
    const tracker = document.getElementById("gTracker") as HTMLElement;
    const before = ta?.value;
    tracker.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "x" })
    );
    expect(await until(() => ta?.value !== before)).toBe(true);
    // the next pattern is another text
    press(document.querySelector('#gOrder .ochip[data-i="1"]'));
    expect(await until(() => ta?.value.startsWith("g4") ?? false)).toBe(true);
    expect(document.querySelector(".mml-top b")?.textContent).toContain(
      "in pattern b"
    );
    press(headBtn(0, "text"));
    expect(document.querySelector(".mml-ta")).toBeNull();
  });

  it("changes the grid when text is typed, in one undo step, and leaves the grid alone on a mistake", async () => {
    await makeMmlSong("mml-type", "o4 l4 c d e f");
    await goSong("mml-type");
    press(headBtn(0, "text"));
    const ta = textArea(
      songValue("mml-type").channels[0]?.id as string
    ) as HTMLTextAreaElement;
    const doc = project().get("song", "mml-type");
    const before = notesOf("mml-type", "a");
    ta.focus();
    ta.value = "o4 l8 g";
    fire(ta, "input");
    ta.value = "o4 l8 g a";
    fire(ta, "input");
    expect(await until(() => noteAt(2, 0) === "A-4")).toBe(true);
    expect(noteAt(0, 0)).toBe("G-4");
    expect(noteAt(4, 0)).toBe("===");
    expect(document.querySelector(".mml-msg")?.textContent).toBe("ok");
    // a mistake is reported under the box and the grid keeps what it had
    ta.value = "o4 l8 g a zz";
    fire(ta, "input");
    await settle(250);
    expect(document.querySelector(".mml-msg")?.classList.contains("bad")).toBe(
      true
    );
    expect(noteAt(0, 0)).toBe("G-4");
    // the two good inputs were one typing burst: one undo brings the old notes back
    expect(doc?.history.canUndo).toBe(true);
    appMod.app.undo();
    expect(notesOf("mml-type", "a")).toEqual(before);
  });

  it("leaves out the rows past the end of the pattern and says so", async () => {
    await makeMmlSong("mml-long", "o4 l4 c");
    await goSong("mml-long");
    press(headBtn(0, "text"));
    const ta = textArea(
      songValue("mml-long").channels[0]?.id as string
    ) as HTMLTextAreaElement;
    ta.focus();
    ta.value = "o4 l4 c d e f g a b";
    fire(ta, "input");
    expect(await until(() => noteAt(12, 0) === "F-4")).toBe(true);
    expect(document.querySelector(".mml-msg")?.textContent).toContain(
      "rows past the end of the pattern were left out"
    );
    expect(songValue("mml-long").patterns.a?.tracks).not.toHaveProperty("x");
  });
});

describe("a channel the converter kept as MML", () => {
  it("is read only, shows its text with a reason, and becomes patterns once the text fits", async () => {
    await makeMmlSong("mml-kept", "q7 l12 c d e f");
    await goSong("mml-kept");
    const s = songValue("mml-kept");
    expect(s.channels[0]?.mml).not.toBeNull();
    expect(
      document.querySelectorAll('.tr-body .tc.is-mml[data-ch="0"]').length
    ).toBeGreaterThanOrEqual(16);
    const ta = textArea(s.channels[0]?.id as string) as HTMLTextAreaElement;
    expect(ta.value).toBe("q7 l12 c d e f");
    expect(document.querySelector(".mml-note")?.textContent).toContain(
      "falls between the rows"
    );
    // a key on its cells changes nothing and says where the notes are
    const before = JSON.stringify(songValue("mml-kept"));
    const tracker = document.getElementById("gTracker") as HTMLElement;
    tracker.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "z" })
    );
    expect(toastText()).toContain("stays as text");
    expect(JSON.stringify(songValue("mml-kept"))).toBe(before);
    // text that lands on rows turns the channel into patterns
    ta.focus();
    ta.value = "o4 l4 c d e f";
    fire(ta, "input");
    expect(
      await until(() => songValue("mml-kept").channels[0]?.mml === null)
    ).toBe(true);
    expect(noteAt(4, 0)).toBe("D-4");
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
