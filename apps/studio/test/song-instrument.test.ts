/* Regression tests for bugs found by using the studio in a browser: switching songs from the sidebar, the piano strip
   and the keys of the song editor, instruments opened from a song, and deleting songs and instruments. The shell is
   real, on the fake engine and a browser store, and every test drives the real controls. What the engine gets is
   judged the way the real worklet treats it (see `heard`), because the fake engine is more forgiving than that one. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Song } from "../src/lib/contract.ts";
import { chipChannels, defaultSong } from "../src/lib/core.ts";
import { ServerStore } from "../src/store/server.ts";
import { installCanvasStub, settle, until } from "./helpers.ts";

installCanvasStub();
vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

type AppMod = typeof import("../src/app.ts");
type DocsMod = typeof import("../src/state/docs.ts");
type EngineMod = typeof import("../src/engine/engine.ts");

let appMod: AppMod;
let docsMod: DocsMod;
let engineMod: EngineMod;

interface Sent {
  type: string;
  [k: string]: unknown;
}
const sent: Sent[] = [];
const sentSince = (mark: number, type: string) =>
  sent.slice(mark).filter((m) => m.type === type);
/** The name of the song the last loadSong after `mark` handed the engine. */
const loadedName = (mark: number) =>
  (sentSince(mark, "loadSong").at(-1)?.song as Song | undefined)?.name;

/** Channels the worklet hosts while no song is loaded: one per kind. */
const PREVIEW_CHANNELS = 7;

/**
 * The notes the real worklet would sound among the messages after `mark`. It keeps the instruments of the song it was
 * given and nothing else: loadSong and unloadSong both drop whatever was uploaded before, a note on needs an instrument
 * it holds and a channel the loaded chip has, and a muted channel is silent.
 */
function heard(
  mark: number
): { channel: number; note: number; inst: string }[] {
  const out: { channel: number; note: number; inst: string }[] = [];
  let insts = new Set<string>();
  let channels = PREVIEW_CHANNELS;
  const muted = new Set<number>();
  for (const [i, m] of sent.entries()) {
    if (m.type === "loadSong") {
      insts = new Set(Object.keys(m.instruments as object));
      const song = m.song as Song;
      channels = chipChannels(song).length;
      muted.clear();
      for (const [c, ch] of song.channels.entries()) {
        if (ch.muted) {
          muted.add(c);
        }
      }
    } else if (m.type === "unloadSong") {
      insts = new Set();
      channels = PREVIEW_CHANNELS;
      muted.clear();
    } else if (m.type === "setInstrument") {
      insts.add(m.id as string);
    } else if (m.type === "setChannel" && m.muted !== undefined) {
      if (m.muted) {
        muted.add(m.channel as number);
      } else {
        muted.delete(m.channel as number);
      }
    } else if (m.type === "noteOn" && i >= mark) {
      const channel = m.channel as number;
      const inst = m.instrument as string;
      if (insts.has(inst) && channel < channels && !muted.has(channel)) {
        out.push({ channel, inst, note: m.note as number });
      }
    }
  }
  return out;
}

const project = () => docsMod.project;
const songValue = (id: string) => project().get("song", id)?.value as Song;
const press = (el: Element | null) => {
  expect(el).not.toBeNull();
  (el as HTMLElement).click();
};
const key = (k: string) =>
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: k })
  );
const pointerDown = (el: Element, init: PointerEventInit = {}) =>
  el.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, button: 0, ...init })
  );

const go = async (hash: string, ready: () => boolean) => {
  appMod.app.navigate(hash);
  expect(await until(ready, 6000)).toBe(true);
  // a hashchange queued by an earlier navigation lands after this one; let it, so it cannot remount the view mid-test
  await settle(30);
};
const goSong = (id: string) =>
  go(`#/song/${id}`, () => document.querySelectorAll(".trow").length > 8);
const goInstrument = (id: string) =>
  go(`#/instrument/${id}`, () => document.getElementById("iKeys") !== null);

/** A song of the project's chip with a pattern of 16 empty rows, under `name`. */
const makeSong = async (id: string, name: string, tempo = 120) => {
  const song = defaultSong(project().project.chip);
  song.name = name;
  song.tempo = tempo;
  song.patterns = { "pattern-1": { length: 16, tracks: {} } };
  song.order = ["pattern-1"];
  for (const ch of song.channels) {
    const match = project()
      .list("instrument")
      .find((d) => (d.value as { kind: string }).kind === ch.kind);
    ch.instrument = match?.id ?? null;
  }
  await project().create("song", id, song);
};

const sidebarRow = (href: string) =>
  document
    .querySelector(`.tree-item a[href="${href}"]`)
    ?.closest(".tree-item") ?? null;
const sidebarPlay = (href: string) =>
  press(sidebarRow(href)?.querySelector("button.pl") ?? null);
const toast = () => document.getElementById("toast") as HTMLElement;
const dialog = () => document.querySelector(".confirm");

beforeAll(async () => {
  // happy-dom lays nothing out: give the song editor's piano strip a size (28 white keys of 12 px) so the pointer
  // positions mean something
  const layout = HTMLCanvasElement.prototype.getBoundingClientRect;
  HTMLCanvasElement.prototype.getBoundingClientRect = function sized() {
    if (this.id !== "gKeys") {
      return layout.call(this);
    }
    return {
      bottom: 42,
      height: 42,
      left: 0,
      right: 336,
      top: 0,
      width: 336,
      x: 0,
      y: 0,
    } as DOMRect;
  };
  (
    window as unknown as { happyDOM?: { setURL: (url: string) => void } }
  ).happyDOM?.setURL("http://localhost:3000/?engine=fake&store=local#/pads");
  document.body.innerHTML =
    '<canvas id="backdrop"></canvas><div id="app"></div>';
  appMod = await import("../src/app.ts");
  docsMod = await import("../src/state/docs.ts");
  engineMod = await import("../src/engine/engine.ts");
  const { boot } = await import("../src/shell.ts");
  await boot(document.getElementById("app") as HTMLElement);
  const { node } = engineMod.engine;
  if (node) {
    const send = node.send.bind(node);
    node.send = (msg) => {
      sent.push(msg as never);
      send(msg);
    };
  }
  await until(() => document.querySelectorAll(".tree-item").length > 0);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("playing one song after another", () => {
  it("a song played from the sidebar while another song is open shows that song and plays it", async () => {
    await makeSong("tune-a", "Tune A", 100);
    await makeSong("tune-b", "Tune B", 77);
    await goSong("tune-a");
    expect((document.getElementById("gTempo") as HTMLInputElement).value).toBe(
      "100"
    );
    await until(() => sidebarRow("#/song/tune-b") !== null);
    const mark = sent.length;
    sidebarPlay("#/song/tune-b");
    // the engine holds Tune B and plays it
    expect(loadedName(mark)).toBe("Tune B");
    expect(sentSince(mark, "play")).toHaveLength(1);
    // and the editor moved on to it instead of drawing Tune B's playhead over the pattern of Tune A
    expect(await until(() => location.hash === "#/song/tune-b", 4000)).toBe(
      true
    );
    expect(
      await until(
        () =>
          (document.getElementById("gTempo") as HTMLInputElement | null)
            ?.value === "77",
        4000
      )
    ).toBe(true);
    // opening the editor of the song that plays does not stop it or load it a second time
    expect(sentSince(mark, "loadSong")).toHaveLength(1);
    expect(sentSince(mark, "stop")).toHaveLength(0);
  });

  it("Play in a song editor starts its own song when the engine holds another one, instead of pausing that one", async () => {
    await makeSong("tune-c", "Tune C", 90);
    await makeSong("tune-d", "Tune D", 95);
    await goSong("tune-c");
    // another song starts without opening it (a CLI play request, not a visual one)
    const { playSongDoc } = await import("../src/playback.ts");
    playSongDoc(project().get("song", "tune-d") as never);
    const mark = sent.length;
    press(document.getElementById("gPlay"));
    expect(sentSince(mark, "pause")).toHaveLength(0);
    expect(loadedName(mark)).toBe("Tune C");
    expect(sentSince(mark, "play")).toHaveLength(1);
  });
});

describe("notes in the song editor", () => {
  const note = (row: number, channel: number) =>
    document.querySelector(
      `.trow[data-r="${row}"] .tc[data-ch="${channel}"] [data-f="0"]`
    ) as Element;

  it("the piano strip plays the key under the mouse on the cursor's channel and lets go when the button comes up", async () => {
    await makeSong("strip-song", "Strip song");
    await goSong("strip-song");
    const second = 1;
    pointerDown(note(0, second));
    const strip = document.getElementById("gKeys") as HTMLElement;
    strip.setPointerCapture = () => undefined;
    const at = (type: string, x: number, y: number) =>
      strip.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: y,
          pointerId: 7,
        })
      );
    const mark = sent.length;
    // the first white key is C2 (36); a black key sits on top of the next one
    at("pointerdown", 5, 40);
    at("pointerup", 5, 40);
    at("pointerdown", 12, 10);
    at("pointerup", 12, 10);
    const insts = songValue("strip-song").channels;
    expect(heard(mark)).toEqual([
      { channel: second, inst: insts[second]?.instrument, note: 36 },
      { channel: second, inst: insts[second]?.instrument, note: 37 },
    ]);
    expect(sentSince(mark, "noteOff")).toHaveLength(2);
    // the song stays loaded: nothing was unloaded to make room for the note
    expect(sentSince(mark, "unloadSong")).toHaveLength(0);
  });

  it("every key typed in the note column sounds, one after the other, and the song stays loaded", async () => {
    await makeSong("typed-song", "Typed song");
    await goSong("typed-song");
    const mark = sent.length;
    pointerDown(note(0, 0));
    const first = songValue("typed-song").channels[0]?.instrument;
    key("z");
    // the editor sends the edited song to the engine a moment later; the next key has to sound after that too
    await settle(400);
    key("x");
    await settle(400);
    key("c");
    expect(heard(mark).map((n) => [n.channel, n.inst])).toEqual([
      [0, first],
      [0, first],
      [0, first],
    ]);
    expect(heard(mark).map((n) => n.note)).toHaveLength(3);
    expect(sentSince(mark, "unloadSong")).toHaveLength(0);
    // the song itself still plays after the notes
    const played = sent.length;
    press(document.getElementById("gPlay"));
    expect(sentSince(played, "play")).toHaveLength(1);
  });
});

describe("an instrument opened from a song", () => {
  it("Play sounds a note: the instrument is in the engine after the song was dropped to make room for the preview", async () => {
    await makeSong("owner-song", "Owner song");
    await goSong("owner-song");
    const open = [
      ...document.querySelectorAll<HTMLElement>("#insp button"),
    ].find((b) => b.textContent?.startsWith("Open "));
    press(open ?? null);
    expect(
      await until(() => document.getElementById("iKeys") !== null, 4000)
    ).toBe(true);
    await settle(30);
    const id = location.hash.replace("#/instrument/", "");
    const mark = sent.length;
    press(document.getElementById("iPlay"));
    expect(heard(mark)).toMatchObject([{ inst: id }]);
    // and again, and from the keyboard
    await settle(600);
    const again = sent.length;
    press(document.getElementById("iPlay"));
    key("z");
    expect(heard(again).map((n) => n.inst)).toEqual([id, id]);
  });

  it("sounds after a song that was played from the sidebar, and a song loaded later is not left without its instruments", async () => {
    await makeSong("loaded-song", "Loaded song");
    const [inst] = project().list("instrument");
    expect(inst).toBeDefined();
    await goInstrument(inst?.id as string);
    await until(() => sidebarRow("#/song/loaded-song") !== null);
    const mark = sent.length;
    sidebarPlay("#/song/loaded-song");
    await goInstrument(inst?.id as string);
    press(document.getElementById("iPlay"));
    expect(heard(mark).filter((n) => n.inst === inst?.id)).toHaveLength(1);
    // the song editor, opened again, can play the instrument of its channel
    await goSong("loaded-song");
    const typed = sent.length;
    pointerDown(
      document.querySelector(
        '.trow[data-r="0"] .tc[data-ch="0"] [data-f="0"]'
      ) as Element
    );
    key("z");
    expect(heard(typed)).toHaveLength(1);
  });
});

describe("deleting a song or an instrument", () => {
  const confirmDelete = async () => {
    expect(await until(() => dialog() !== null, 2000)).toBe(true);
    press(document.querySelector(".confirm-btns .btn.primary"));
  };
  const stored = async () => (await project().store.list()).map((f) => f.path);

  it("the song editor asks first, then removes the song from the project, the sidebar and the store, and Undo brings it back", async () => {
    await makeSong("doomed-song", "Doomed song");
    await goSong("doomed-song");
    const del = [
      ...document.querySelectorAll<HTMLElement>("#insp button"),
    ].find((b) => b.textContent === "Delete song");
    // declining keeps everything
    press(del ?? null);
    expect(dialog()?.textContent).toContain("Doomed song");
    press(document.querySelector(".confirm-btns .btn:not(.primary)"));
    await settle(30);
    expect(project().get("song", "doomed-song")).toBeDefined();
    expect(await stored()).toContain("songs/doomed-song.json");
    // confirming removes it everywhere
    press(del ?? null);
    await confirmDelete();
    expect(await until(() => !project().get("song", "doomed-song"), 4000)).toBe(
      true
    );
    expect(await stored()).not.toContain("songs/doomed-song.json");
    expect(
      await until(() => sidebarRow("#/song/doomed-song") === null, 4000)
    ).toBe(true);
    expect(await until(() => location.hash === "#/pads", 4000)).toBe(true);
    expect(toast().textContent).toContain("Deleted Doomed song");
    // Undo writes the same song back and opens it
    press(toast().querySelector("button"));
    expect(
      await until(() => !!project().get("song", "doomed-song"), 4000)
    ).toBe(true);
    expect(await stored()).toContain("songs/doomed-song.json");
    expect(songValue("doomed-song").name).toBe("Doomed song");
    expect(
      await until(() => sidebarRow("#/song/doomed-song") !== null, 4000)
    ).toBe(true);
  });

  it("the instrument editor deletes an instrument the same way and says how many songs use it", async () => {
    const [source] = project().list("instrument");
    const copy = await project().duplicate(source as never);
    await makeSong("user-song", "User song");
    await project().edit<Song>(
      project().get("song", "user-song") as never,
      (s) => {
        const [ch] = s.channels;
        if (ch) {
          ch.instrument = copy.id;
        }
      }
    );
    await goInstrument(copy.id);
    const del = [
      ...document.querySelectorAll<HTMLElement>("#insp button"),
    ].find((b) => b.textContent === "Delete instrument");
    press(del ?? null);
    expect(dialog()?.textContent).toContain("One song uses it");
    await confirmDelete();
    expect(await until(() => !project().get("instrument", copy.id), 4000)).toBe(
      true
    );
    expect(await stored()).not.toContain(`instruments/${copy.id}.json`);
    expect(
      await until(() => sidebarRow(`#/instrument/${copy.id}`) === null, 4000)
    ).toBe(true);
    press(toast().querySelector("button"));
    expect(
      await until(() => !!project().get("instrument", copy.id), 4000)
    ).toBe(true);
    expect(await stored()).toContain(`instruments/${copy.id}.json`);
  });

  it("a studio server that refuses the delete leaves the document in the project", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response("no", { status: 500 }))
    );
    const store = new ServerStore("http://srv");
    await expect(store.remove("songs/x.json")).rejects.toThrow("500");
    // a file that is already gone is what was asked for
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response("", { status: 404 }))
    );
    await expect(store.remove("songs/x.json")).resolves.toBeUndefined();
  });
});
