/* Importing a MIDI file in the studio: the sidebar button, the palette command, dropping a .mid on the window, the chip
   dialog, and what lands in the project. The app runs on the fake engine and the browser store, like studio.test.ts. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { installCanvasStub, settle, until } from "./helpers.ts";

installCanvasStub();

/* A format 0 file at 96 ppq, 120 BPM: four melody notes on channel 1 (one per beat) and, on channel 10, a kick and a
   hat on the same tick, which a one-voice noise channel cannot play together. */
function tune(): Uint8Array<ArrayBuffer> {
  const ev = (delta: number, ...data: number[]) => [delta, ...data];
  const body = [
    ...ev(0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20),
    ...ev(0, 0x90, 72, 100),
    ...ev(0, 0x99, 36, 120),
    ...ev(0, 0x99, 42, 80),
    ...ev(96, 0x80, 72, 0),
    ...ev(0, 0x89, 36, 0),
    ...ev(0, 0x89, 42, 0),
    ...ev(0, 0x90, 74, 100),
    ...ev(96, 0x80, 74, 0),
    ...ev(0, 0x90, 76, 100),
    ...ev(96, 0x80, 76, 0),
    ...ev(0, 0x90, 77, 100),
    ...ev(96, 0x80, 77, 0),
    ...ev(0, 0xff, 0x2f, 0),
  ];
  // delta times above 127 need two bytes: every delta here is 0 or 96, so the file stays single byte
  const head = [..."MThd"].map((c) => c.charCodeAt(0));
  const trk = [..."MTrk"].map((c) => c.charCodeAt(0));
  return Uint8Array.from([
    ...head,
    0,
    0,
    0,
    6,
    0,
    0,
    0,
    1,
    0,
    96,
    ...trk,
    0,
    0,
    0,
    body.length,
    ...body,
  ]);
}

function dropEvent(files: File[]): Event {
  const e = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", {
    value: { files, types: ["Files"] },
  });
  return e;
}

describe("importing a MIDI file", () => {
  let appMod: typeof import("../src/app.ts");
  let docsMod: typeof import("../src/state/docs.ts");

  const toastText = () => document.getElementById("toast")?.textContent ?? "";
  const dialogSelect = () =>
    document.querySelector<HTMLSelectElement>(
      '.overlay select[aria-label="Chip"]'
    );
  const closeOverlays = () => {
    for (const o of document.querySelectorAll(".overlay")) {
      o.remove();
    }
  };

  beforeAll(async () => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      addEventListener: () => undefined,
      matches: false,
      media,
      removeEventListener: () => undefined,
    }));
    (
      window as unknown as { happyDOM?: { setURL: (url: string) => void } }
    ).happyDOM?.setURL("http://localhost:3000/?engine=fake&store=local#/pads");
    document.body.innerHTML =
      '<canvas id="backdrop"></canvas><div id="app"></div>';
    appMod = await import("../src/app.ts");
    docsMod = await import("../src/state/docs.ts");
    const { boot } = await import("../src/shell.ts");
    await boot(document.getElementById("app") as HTMLElement);
    await until(() => docsMod.project.list("song").length > 0);
  });

  it("has an Import MIDI button next to New in the Songs section and a command in the palette", () => {
    const heads = [...document.querySelectorAll<HTMLElement>("#side .tree-h")];
    const songs = heads.find((el) => el.textContent?.includes("Songs"));
    expect(
      songs?.querySelector('button[aria-label="Import MIDI"]')
    ).not.toBeNull();
    expect(
      songs?.querySelector('button[aria-label="New Songs"]')
    ).not.toBeNull();
    // the other sections have only their New button
    const sfx = heads.find((el) => el.textContent?.includes("SFX"));
    expect(sfx?.querySelector('button[aria-label="Import MIDI"]')).toBeNull();

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "k" })
    );
    const input = document.querySelector<HTMLInputElement>(
      '.overlay input[aria-label="Command"]'
    );
    (input as HTMLInputElement).value = "midi";
    input?.dispatchEvent(new Event("input", { bubbles: true }));
    const titles = [...document.querySelectorAll(".overlay .cmd .nm")].map(
      (n) => n.textContent
    );
    expect(titles[0]).toBe("Import MIDI file");
    closeOverlays();
  });

  it("ignores a drag that carries no files, such as an order chip being moved", () => {
    const data = new Map<string, string>();
    // what an in-page drag has: text data and no `types` list at all, or a list without "Files"
    for (const dataTransfer of [
      { getData: (k: string) => data.get(k) ?? "", setData: () => undefined },
      { files: [], types: ["text/plain"] },
    ]) {
      for (const type of ["dragover", "drop"]) {
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(e, "dataTransfer", { value: dataTransfer });
        expect(() => document.body.dispatchEvent(e)).not.toThrow();
        expect(e.defaultPrevented).toBe(false);
      }
    }
    expect(dialogSelect()).toBeNull();
  });

  it("opens the chip dialog when a .mid file is dropped, and imports it for the chosen chip", async () => {
    const { project } = docsMod;
    const before = project.list("song").length;
    const file = new File([tune()], "Boss Tune.mid", { type: "audio/midi" });
    const drop = dropEvent([file]);
    document.body.dispatchEvent(drop);
    // the browser must not open the dropped file
    expect(drop.defaultPrevented).toBe(true);
    expect(await until(() => dialogSelect() !== null)).toBe(true);
    const options = [...(dialogSelect()?.options ?? [])].map((o) => o.value);
    expect(options).toEqual([
      "nes",
      "gameboy",
      "c64",
      "genesis",
      "adlib",
      "snes",
    ]);
    // it starts on the project's chip (the starter project is NES)
    expect(dialogSelect()?.value).toBe("nes");
    (dialogSelect() as HTMLSelectElement).value = "genesis";
    document
      .querySelector<HTMLButtonElement>(".overlay .confirm-btns .btn.primary")
      ?.click();

    expect(
      await until(() => project.get("song", "boss-tune") !== undefined)
    ).toBe(true);
    expect(project.list("song").length).toBe(before + 1);
    const song = project.get("song", "boss-tune")?.value as {
      channels: { id: string; instrument: string | null }[];
      chip: string;
      name: string;
      tempo: number;
    };
    expect(song).toMatchObject({
      chip: "genesis",
      name: "Boss Tune",
      tempo: 120,
    });
    // melody on the first FM lead channel, drums on the PSG noise channel, both with instruments that now exist
    const used = Object.fromEntries(
      song.channels.map((c) => [c.id, c.instrument])
    );
    expect(used.fm2).toBe("midi-genesis-lead");
    expect(used.psgNoise).toBe("midi-genesis-drums");
    expect(project.get("instrument", "midi-genesis-lead")).toBeDefined();
    expect(project.get("instrument", "midi-genesis-drums")).toBeDefined();
    // it opens the song
    expect(await until(() => location.hash === "#/song/boss-tune")).toBe(true);
    // and says what was lost: the hat that shared a row with the kick
    expect(await until(() => toastText().includes("Imported Boss Tune"))).toBe(
      true
    );
    expect(toastText()).toContain("1 thing was dropped or changed");
    const details = [
      ...document.querySelectorAll<HTMLButtonElement>("#toast button"),
    ].find((b) => b.textContent === "Details");
    expect(details).toBeDefined();
    details?.click();
    expect(document.querySelector(".overlay")?.textContent).toContain(
      "psgNoise: 1 drum hits dropped"
    );
    closeOverlays();
  });

  it("gives a second import of the same file its own song id and keeps the instruments it already made", async () => {
    const { project } = docsMod;
    const lead = project.get("instrument", "midi-genesis-lead");
    const file = new File([tune()], "Boss Tune.mid");
    document.body.dispatchEvent(dropEvent([file]));
    await until(() => dialogSelect() !== null);
    (dialogSelect() as HTMLSelectElement).value = "genesis";
    document
      .querySelector<HTMLButtonElement>(".overlay .confirm-btns .btn.primary")
      ?.click();
    expect(
      await until(() => project.get("song", "boss-tune-2") !== undefined)
    ).toBe(true);
    expect(project.get("instrument", "midi-genesis-lead")).toBe(lead);
    closeOverlays();
  });

  it("says so, instead of opening a dialog, for a .mid file that is not MIDI; and ignores other files", async () => {
    closeOverlays();
    const bad = new File([new Uint8Array([1, 2, 3, 4])], "broken.mid");
    document.body.dispatchEvent(dropEvent([bad]));
    expect(
      await until(() => toastText().includes("Could not import broken.mid"))
    ).toBe(true);
    expect(document.querySelector(".overlay")).toBeNull();

    const other = new File(["hello"], "notes.txt");
    const drop = dropEvent([other]);
    document.body.dispatchEvent(drop);
    await settle(80);
    expect(document.querySelector(".overlay")).toBeNull();
    // still swallowed, so a stray drop never navigates the studio away to the file
    expect(drop.defaultPrevented).toBe(true);
    expect(appMod.app.route.view).toBe("song");
  });
});
