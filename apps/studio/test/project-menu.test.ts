/* The project menu in the top bar, the clean project and the empty views, in the real shell on the fake engine and a
   browser store: what the person gets is checked, not the functions behind it. Export is stubbed (a real render is
   not what these tests are about) and downloads are recorded by name. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sfx } from "../src/lib/contract.ts";
import { installCanvasStub, settle, until } from "./helpers.ts";

installCanvasStub();
vi.setConfig({ hookTimeout: 30_000, testTimeout: 5000 });

type AppMod = typeof import("../src/app.ts");
type DocsMod = typeof import("../src/state/docs.ts");
let appMod: AppMod;
let docsMod: DocsMod;

const project = () => docsMod.project;
const toast = () => {
  const el = document.getElementById("toast") as HTMLElement;
  return el.hidden ? "" : (el.querySelector("span")?.textContent ?? "");
};
const press = (el: Element | null) => {
  expect(el).not.toBeNull();
  (el as HTMLElement).click();
};
const count = () =>
  project().list("sfx").length +
  project().list("song").length +
  project().list("instrument").length;
const sfxIds = () =>
  project()
    .list("sfx")
    .map((d) => d.id)
    .sort();

/** Open the project menu and press one of its items. */
const menu = (action: string) => {
  press(document.getElementById("projMenuBtn"));
  press(document.querySelector(`.pmenu-item[data-action="${action}"]`));
};
const confirm = () =>
  press(document.querySelector(".confirm-btns .btn.primary"));
const dialogGone = () => document.querySelector(".overlay") === null;

const go = async (hash: string, ready: () => boolean) => {
  appMod.app.navigate(hash);
  const target = JSON.stringify(appMod.parseRoute(hash));
  expect(
    await until(() => JSON.stringify(appMod.app.route) === target, 3000)
  ).toBe(true);
  expect(await until(ready, 3000)).toBe(true);
  await settle(5);
};

/** Downloads, by file name, while `act` runs. */
async function downloads(act: () => Promise<void> | void): Promise<string[]> {
  const names: string[] = [];
  const { createObjectURL } = URL;
  const { click } = HTMLAnchorElement.prototype;
  URL.createObjectURL = () => "blob:test";
  HTMLAnchorElement.prototype.click = function recorded(
    this: HTMLAnchorElement
  ) {
    names.push(this.download);
  };
  try {
    await act();
    await settle(20);
  } finally {
    URL.createObjectURL = createObjectURL;
    HTMLAnchorElement.prototype.click = click;
  }
  return names;
}

beforeAll(async () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  (
    window as unknown as { happyDOM?: { setURL: (url: string) => void } }
  ).happyDOM?.setURL("http://localhost:3000/?engine=fake&store=local#/pads");
  document.body.innerHTML =
    '<canvas id="backdrop"></canvas><div id="app"></div>';
  appMod = await import("../src/app.ts");
  docsMod = await import("../src/state/docs.ts");
  const { boot } = await import("../src/shell.ts");
  await boot(document.getElementById("app") as HTMLElement);
  await until(() => document.querySelectorAll(".pad[data-id]").length > 0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the project menu", () => {
  it("is the project name in the top bar and lists every project action", () => {
    const btn = document.getElementById("projMenuBtn") as HTMLElement;
    expect(btn.textContent).toContain(project().project.name);
    expect(document.querySelector(".pmenu-list")?.hasAttribute("hidden")).toBe(
      true
    );
    press(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(
      [...document.querySelectorAll(".pmenu-item")].map((i) => i.textContent)
    ).toEqual([
      "New project",
      "Open or import zip or JSON",
      "Open or import a folder",
      "Export project as zip",
      "Export audio for a game",
      "Start over with the starter kit",
    ]);
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("offers the same actions in the command palette", () => {
    press(document.getElementById("bPal"));
    const input = document.querySelector<HTMLInputElement>(".overlay input");
    (input as HTMLInputElement).value = "project";
    input?.dispatchEvent(new Event("input", { bubbles: true }));
    const titles = [...document.querySelectorAll(".cmd .nm")].map(
      (n) => n.textContent
    );
    for (const t of [
      "New project",
      "Export audio for a game",
      "Start over with the starter kit",
    ]) {
      expect(titles).toContain(t);
    }
    document.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
    );
    expect(dialogGone()).toBe(true);
  });

  it("runs the audio export from the menu and says what it made", async () => {
    const local = await import("../src/export-local.ts");
    const run = vi.spyOn(local, "exportInBrowser").mockResolvedValue({
      bytes: 3,
      entries: [{ data: new Uint8Array(3), path: "public/audio/coin.ogg" }],
      manifest: {},
      notes: [],
      project: project().project,
      zip: new Uint8Array(3),
    } as never);
    const names = await downloads(async () => {
      menu("export-audio");
      await until(() => toast().startsWith("Exported"), 2000);
    });
    const calls = run.mock.calls.length;
    run.mockRestore();
    expect(calls).toBe(1);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/-audio\.zip$/);
    expect(toast()).toBe("Exported 1 files, the zip was downloaded");
  });

  it("starts over from the menu: asks first, then brings back the starter kit and says so", async () => {
    const { starterFiles } = await import("../src/store/seed.ts");
    const starter = [...starterFiles().keys()]
      .filter((p) => p.startsWith("sfx/"))
      .map((p) => p.replace(/^sfx\/|\.json$/g, ""))
      .sort();
    // autosave would write the edit 800 ms later: the clock is faked so it waits
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const doc = project().list("sfx")[0] as never;
    project().edit<Sfx>(doc, (d) => {
      d.volume = 0.123;
    });
    // the edit is a change no zip holds: the dialog offers to download it first
    menu("start-over");
    expect(document.querySelector<HTMLElement>(".choice-check")?.hidden).toBe(
      false
    );
    press(document.querySelector(".confirm-btns .btn:not(.primary)"));
    expect(dialogGone()).toBe(true);
    expect(project().list("sfx")[0]?.dirty).toBe(true);
    const names = await downloads(async () => {
      menu("start-over");
      confirm();
      await until(() => toast() === "Back to the starter kit", 3000);
    });
    // the box is ticked by default, so the project zip came first
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/-project\.zip$/);
    expect(sfxIds()).toEqual(starter);
    expect(appMod.app.route.view).toBe("pads");
  });
});

describe("a clean project", () => {
  it("has no documents, only project.json with the chosen name and chip, and says so in every view", async () => {
    menu("new");
    // the empty project is the default choice, with a name and a chip to pick
    const name = document.querySelector<HTMLInputElement>(
      '.confirm input[type="text"]'
    ) as HTMLInputElement;
    name.value = "Space Blaster";
    const chip = document.querySelector<HTMLSelectElement>(
      ".confirm select"
    ) as HTMLSelectElement;
    chip.value = "gameboy";
    confirm();
    expect(await until(() => count() === 0 && dialogGone(), 3000)).toBe(true);
    expect(project().docs.size).toBe(0);
    expect(project().project.name).toBe("Space Blaster");
    expect(project().project.chip).toBe("gameboy");
    const files = await project().store.list();
    expect(files.map((f) => f.path)).toEqual(["project.json"]);
    expect(
      (document.getElementById("projMenuBtn") as HTMLElement).textContent
    ).toContain("Space Blaster");

    // pads: a friendly empty state with the next steps
    expect(
      await until(() => document.querySelector(".empty-card") !== null)
    ).toBe(true);
    expect(
      [...document.querySelectorAll(".empty-card .btn")].map(
        (b) => b.textContent
      )
    ).toEqual(["New SFX", "New song", "Import MIDI", "Open examples"]);
    expect(document.querySelectorAll(".pad[data-id]")).toHaveLength(0);
    // the sidebar sections each name their next step
    expect(
      [...document.querySelectorAll("#side [data-empty]")].map(
        (b) => b.textContent
      )
    ).toEqual(["Make a sound effect", "Write a song", "Add an instrument"]);

    // every other view renders, and a missing document goes back to the pads
    await go("#/project", () => document.getElementById("pGo") !== null);
    expect(document.querySelector("#pStale")?.textContent).toContain(
      "Nothing to export yet"
    );
    await go("#/analysis", () => document.querySelector(".an-pick") !== null);
    expect(document.querySelector(".an-pick .empty-card")).not.toBeNull();
    await go(
      "#/examples",
      () => document.querySelectorAll(".xcard").length > 0
    );
    for (const hash of ["#/sfx/none", "#/song/none", "#/instrument/none"]) {
      appMod.app.navigate(hash);
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: one route at a time, each must land on the pads before the next
        await until(
          () => appMod.app.route.view === "pads" && location.hash === "#/pads",
          3000
        )
      ).toBe(true);
    }
    // keys that walk the documents do nothing, and the palette still opens
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "]" })
    );
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "[" })
    );
    press(document.getElementById("bPal"));
    expect(document.querySelector(".cmd")).not.toBeNull();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
    );
    // an export of nothing says why it did not run
    menu("export-audio");
    expect(
      await until(
        () => toast().startsWith("Export failed: nothing to export"),
        2000
      )
    ).toBe(true);
  });

  it("takes a first song with no instruments in the project", async () => {
    await go("#/pads", () => document.querySelector(".empty-card") !== null);
    press(document.querySelector('.empty-card [data-step="song"]'));
    expect(
      await until(() => document.querySelectorAll(".trow").length >= 8, 3000)
    ).toBe(true);
    expect(project().list("song")).toHaveLength(1);
    expect(project().list("instrument")).toHaveLength(0);
  });

  it("offers the starter kit instead, and the starter kit comes back whole", async () => {
    const { starterFiles } = await import("../src/store/seed.ts");
    const paths = [...starterFiles().keys()].sort();
    menu("new");
    press(document.querySelector('.choice input[value="starter"]'));
    // the song just made is a change no zip holds, so the dialog offers a download first: leave it unticked
    const box = document.querySelector<HTMLInputElement>(".choice-check input");
    expect(document.querySelector<HTMLElement>(".choice-check")?.hidden).toBe(
      false
    );
    (box as HTMLInputElement).checked = false;
    const names = await downloads(async () => {
      confirm();
      await until(() => project().list("sfx").length > 0, 3000);
    });
    expect(names).toEqual([]);
    expect((await project().store.list()).map((f) => f.path).sort()).toEqual(
      paths
    );
    expect(
      project()
        .list("song")
        .map((d) => d.id)
    ).toEqual(["starter-theme"]);
    expect(project().list("instrument").length).toBeGreaterThan(0);
    expect(location.hash).toBe("#/pads");
  });

  it("offers nothing to download when the project holds nothing that is not saved in a zip", () => {
    // right after the starter kit came back it is as it ships: nothing to lose
    menu("new");
    expect(document.querySelector<HTMLElement>(".choice-check")?.hidden).toBe(
      true
    );
    press(document.querySelector(".confirm-btns .btn:not(.primary)"));
    expect(dialogGone()).toBe(true);
    expect(project().list("sfx").length).toBeGreaterThan(0);
  });
});

describe("with a project folder behind the studio server", () => {
  it("dims what does not apply, says why, and keeps export audio", () => {
    const real = project().store;
    const served = Object.create(real, {
      mode: { value: "server" },
    }) as typeof real;
    project().store = served;
    try {
      press(document.getElementById("projMenuBtn"));
      const item = (a: string) =>
        document.querySelector<HTMLElement>(
          `.pmenu-item[data-action="${a}"]`
        ) as HTMLElement;
      for (const a of [
        "new",
        "open",
        "open-folder",
        "export-zip",
        "start-over",
      ]) {
        expect(item(a).getAttribute("aria-disabled")).toBe("true");
        expect(item(a).title.length).toBeGreaterThan(20);
      }
      expect(item("export-audio").getAttribute("aria-disabled")).toBeNull();
      // pressing a dimmed one explains instead of doing nothing
      press(item("new"));
      expect(toast()).toContain("folder");
      expect(document.querySelector(".overlay")).toBeNull();
    } finally {
      project().store = real;
    }
  });
});
