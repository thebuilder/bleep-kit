/* The export settings make sense in both places the studio runs: the browser shows and edits the zip layout, the CLI
   studio shows disk paths, and the stored project keeps the CLI's form either way. Rendering and encoding are stubbed
   (a real render is not what these tests are about). */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DIR,
  DEFAULT_MANIFEST,
  exportFieldCopy,
  storedFromZip,
  zipLayout,
  zipPath,
} from "../src/export-paths.ts";
import { installCanvasStub, settle, until } from "./helpers.ts";

installCanvasStub();
vi.setConfig({ hookTimeout: 30_000, testTimeout: 5000 });

type AppMod = typeof import("../src/app.ts");
type DocsMod = typeof import("../src/state/docs.ts");
let appMod: AppMod;
let docsMod: DocsMod;

const project = () => docsMod.project;
const view = () => document.getElementById("view") as HTMLElement;

describe("the zip layout of the stored export paths", () => {
  it("drops the leading ../ of a disk path and falls back to the defaults for anything a zip cannot hold", () => {
    expect(
      zipLayout({ dir: "../public/audio", manifest: "../src/audio.ts" })
    ).toEqual({
      dir: "public/audio",
      manifest: "src/audio.ts",
    });
    expect(zipPath("../../assets/sfx/", DEFAULT_DIR)).toBe("assets/sfx");
    expect(zipPath("out\\audio", DEFAULT_DIR)).toBe("out/audio");
    for (const disk of [
      "/home/me/game/audio",
      "C:/game/audio",
      "~/audio",
      "",
      "..",
    ]) {
      expect(zipPath(disk, DEFAULT_DIR)).toBe("public/audio");
    }
  });

  it("stores what was typed in the form the CLI reads, and leaves an untouched value alone", () => {
    expect(
      storedFromZip("public/sounds/", "../public/audio", DEFAULT_DIR)
    ).toBe("../public/sounds");
    expect(
      storedFromZip("src/sounds.ts", "../src/audio.ts", DEFAULT_MANIFEST)
    ).toBe("../src/sounds.ts");
    // the same folder in another spelling keeps the stored value, even one the browser does not show as typed
    expect(storedFromZip("public/audio/", "../public/audio", DEFAULT_DIR)).toBe(
      "../public/audio"
    );
    expect(storedFromZip("audio", "audio", DEFAULT_DIR)).toBe("audio");
    // a disk path is replaced as soon as there is something to replace it with, and an empty field means the default
    expect(storedFromZip("public/audio", "/home/me/audio", DEFAULT_DIR)).toBe(
      "../public/audio"
    );
    expect(storedFromZip("  ", "../x", DEFAULT_DIR)).toBe(DEFAULT_DIR);
  });

  it("labels the fields for what they do in each mode", () => {
    const web = exportFieldCopy(true);
    expect(web.dirLabel).toBe("Audio folder in the zip");
    expect(web.manifestLabel).toBe("Manifest file in the zip");
    expect(web.dirHint).toBe("Unzip into your game's project root.");
    const cli = exportFieldCopy(false);
    expect(cli.dirLabel).toBe("Audio folder (relative to the project)");
    expect(cli.manifestLabel).toBe("Manifest file (relative to the project)");
    expect(cli.dirPlaceholder).toBe(DEFAULT_DIR);
  });
});

describe("the project page", () => {
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

  const open = async (hash: string, ready: () => boolean) => {
    appMod.app.navigate(hash);
    expect(await until(ready, 3000)).toBe(true);
    await settle(5);
  };
  const openProject = async () => {
    await open(
      "#/pads",
      () => document.querySelector(".pad[data-id]") !== null
    );
    await open("#/project", () => document.getElementById("pGo") !== null);
  };
  const labels = () =>
    [...view().querySelectorAll("#pExpB .fld > label")].map(
      (l) => l.textContent
    );
  const input = (label: string) =>
    [...view().querySelectorAll("#pExpB .fld")]
      .find((f) => f.querySelector("label")?.textContent === label)
      ?.querySelector("input") as HTMLInputElement;
  const sub = () => document.getElementById("pExpSub")?.textContent ?? "";
  const type = (el: HTMLInputElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("in the browser shows the zip paths, and typing one stores the disk path the CLI reads", async () => {
    await openProject();
    expect(labels().slice(0, 3)).toEqual([
      "Audio folder in the zip",
      "Manifest file in the zip",
      "URL prefix",
    ]);
    expect(input("Audio folder in the zip").value).toBe("public/audio/");
    expect(input("Manifest file in the zip").value).toBe("src/audio.ts");
    expect(view().textContent).toContain(
      "Unzip into your game's project root."
    );
    expect(view().textContent).not.toContain("../");
    expect(document.getElementById("pExpSub")?.textContent).toContain(
      "a zip with public/audio/ and src/audio.ts"
    );

    type(input("Audio folder in the zip"), "static/sounds/");
    type(input("Manifest file in the zip"), "game/sounds.ts");
    expect(project().project.export.dir).toBe("../static/sounds");
    expect(project().project.export.manifest).toBe("../game/sounds.ts");
    expect(
      await until(() =>
        sub().includes("a zip with static/sounds/ and game/sounds.ts")
      )
    ).toBe(true);
    project().editProject((p) => {
      p.export.dir = DEFAULT_DIR;
      p.export.manifest = DEFAULT_MANIFEST;
    }, "test");
  });

  it("puts the files of the browser zip where the settings say", async () => {
    const encode = await import("../src/encode-service.ts");
    const render = await import("../src/render-service.ts");
    const local = await import("../src/export-local.ts");
    vi.spyOn(render, "renderSfxAsync").mockResolvedValue({
      frames: 480,
      sampleRate: 48_000,
    } as never);
    vi.spyOn(render, "renderSongAsync").mockResolvedValue({
      events: [],
      frames: 480,
      sampleRate: 48_000,
    } as never);
    vi.spyOn(encode, "encodeAudio").mockResolvedValue({
      bytes: new Uint8Array(2),
      used: "ogg",
    } as never);
    const paths = async () =>
      (await local.exportInBrowser(() => undefined)).entries.map((e) => e.path);
    const before = project().project.export;
    try {
      project().editProject((p) => {
        p.export.dir = "../static/sounds";
        p.export.manifest = "../game/sounds.ts";
      }, "test");
      const custom = await paths();
      expect(custom).toContain("static/sounds/manifest.json");
      expect(custom).toContain("game/sounds.ts");
      expect(
        custom.filter((p) => p.startsWith("static/sounds/")).length
      ).toBeGreaterThan(2);
      // a disk path from a CLI project becomes the default layout instead of a path with a drive in it
      project().editProject((p) => {
        p.export.dir = "/home/me/game/public/audio";
        p.export.manifest = "C:/game/src/audio.ts";
      }, "test");
      const disk = await paths();
      expect(disk).toContain("public/audio/manifest.json");
      expect(disk).toContain("src/audio.ts");
    } finally {
      vi.restoreAllMocks();
      project().editProject((p) => {
        p.export.dir = before.dir;
        p.export.manifest = before.manifest;
      }, "test");
    }
  });

  it("with the CLI studio on a folder shows the disk paths, labelled as relative to the project", async () => {
    Object.defineProperty(project().store, "mode", { value: "server" });
    try {
      await openProject();
      expect(labels().slice(0, 3)).toEqual([
        "Audio folder (relative to the project)",
        "Manifest file (relative to the project)",
        "URL prefix",
      ]);
      expect(input("Audio folder (relative to the project)").value).toBe(
        project().project.export.dir
      );
      expect(view().textContent).toContain("The CLI writes");
      expect(view().textContent).not.toContain("Unzip into");
      type(input("Audio folder (relative to the project)"), "../static/audio");
      expect(project().project.export.dir).toBe("../static/audio");
      expect(
        await until(() => sub().includes("writes to ../static/audio"))
      ).toBe(true);
    } finally {
      Object.defineProperty(project().store, "mode", { value: "local" });
      project().editProject((p) => {
        p.export.dir = DEFAULT_DIR;
      }, "test");
    }
  });
});
