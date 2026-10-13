/* Using a Freesound sound: it becomes a sample document that remembers where it came from (author, link, license),
   the badge says so in the sidebar and the sample editor, and a CC BY sound lands in CREDITS.txt of the game export and
   of the project zip, a CC0 sound in neither. The project is real (a browser store in memory); the preview player is
   handed the audio, the export's render and encode are stubs. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FreesoundSound } from "../src/freesound/api.ts";
import { useSound } from "../src/freesound/import.ts";
import type { LoadedPreview } from "../src/freesound/preview.ts";
import type { Song, UserSample } from "../src/lib/contract.ts";
import { CREDITS_FILE } from "../src/lib/core.ts";
import { project } from "../src/state/docs.ts";
import { LocalStore, memoryBackend } from "../src/store/local.ts";
import { readZip } from "../src/zip.ts";
import { settle } from "./helpers.ts";

vi.setConfig({ testTimeout: 15_000 });

const sound = (over: Partial<FreesoundSound> = {}): FreesoundSound => ({
  author: "tester",
  downloads: 10,
  duration: 0.25,
  id: 4242,
  license: "cc0",
  loopable: false,
  name: "Soft Kick",
  note: "A2",
  oneShot: true,
  pv: null,
  rating: 4,
  subcategory: "Percussion",
  tags: ["kick"],
  url: "https://freesound.org/people/tester/sounds/4242/",
  wf: null,
  ...over,
});

/** A player that hands over a decaying 110 Hz tone, as the decoded preview. */
const player = {
  load: (): Promise<LoadedPreview> => {
    const rate = 22_050;
    const mono = Float32Array.from(
      { length: 5000 },
      (_, i) => Math.sin((i / rate) * 110 * Math.PI * 2) * Math.exp(-i / 2500)
    );
    return Promise.resolve({
      mono,
      rate,
      sample: {} as unknown as UserSample,
    });
  },
};

const sampleOf = (id: string) => project.get("sample", id)?.value as UserSample;

beforeEach(async () => {
  project.setAutosave(false);
  await project.load(new LocalStore(memoryBackend()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("using a sound", () => {
  it("stores where a CC0 sound came from, with its detected note", async () => {
    const used = await useSound(sound(), player, "sample", { open: false });
    expect(used?.instrumentId).toBeNull();
    const stored = sampleOf(used?.sampleId as string);
    expect(stored.source).toEqual({
      author: "tester",
      id: 4242,
      kind: "freesound",
      license: "CC0",
      name: "Soft Kick",
      url: "https://freesound.org/people/tester/sounds/4242/",
    });
    expect(stored.baseNote).toBe(45);
    expect(stored.loop).toBeNull();
  });

  it("stores CC BY as CC BY, and makes an instrument that plays the sample on request", async () => {
    const used = await useSound(
      sound({ id: 7, license: "by", name: "Wood Block" }),
      player,
      "instrument",
      { open: false }
    );
    expect(sampleOf(used?.sampleId as string).source?.license).toBe("CC BY");
    const inst = project.get("instrument", used?.instrumentId as string);
    expect(inst?.value).toMatchObject({
      sample: { userSample: used?.sampleId },
    });
  });

  it("keeps the source through a save and a reload of the project", async () => {
    const used = await useSound(sound(), player, "sample", { open: false });
    await project.saveAll();
    await project.load(project.store as LocalStore);
    expect(sampleOf(used?.sampleId as string).source?.id).toBe(4242);
  });

  it("shows the license badge on the sample's row in the sidebar", async () => {
    const { createSidebar } = await import("../src/ui/sidebar.ts");
    const root = document.createElement("div");
    document.body.append(root);
    createSidebar(root);
    await useSound(sound({ id: 8, license: "by" }), player, "sample", {
      open: false,
    });
    await settle(30);
    expect(root.querySelector(".lic-by")?.textContent).toBe("CC BY");
    root.remove();
  });
});

describe("credits in the exports", () => {
  /** A song whose first channel plays instrument `inst`. */
  const songWith = async (inst: string) => {
    const [doc] = project.list("song");
    project.edit<Song>(doc as never, (s) => {
      s.channels[0] = {
        ...(s.channels[0] as Song["channels"][0]),
        instrument: inst,
      };
    });
    await project.saveAll();
  };

  const stubRender = async () => {
    const encode = await import("../src/encode-service.ts");
    const render = await import("../src/render-service.ts");
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
  };

  it("lists a CC BY sound a song plays in CREDITS.txt of the game export", async () => {
    await stubRender();
    const used = await useSound(
      sound({ id: 99, license: "by", name: "Wood Block" }),
      player,
      "instrument",
      { open: false }
    );
    await songWith(used?.instrumentId as string);
    const local = await import("../src/export-local.ts");
    const res = await local.exportInBrowser(() => undefined);
    const file = res.entries.find((e) => e.path.endsWith(`/${CREDITS_FILE}`));
    expect(file?.path).toBe(`public/audio/${CREDITS_FILE}`);
    const text = new TextDecoder().decode(file?.data);
    expect(text).toContain('"Wood Block" by tester, CC BY');
    expect(text).toContain("https://freesound.org/people/tester/sounds/4242/");
  });

  it("writes no credits file when only CC0 sounds are played", async () => {
    await stubRender();
    const used = await useSound(sound(), player, "instrument", { open: false });
    await songWith(used?.instrumentId as string);
    const local = await import("../src/export-local.ts");
    const res = await local.exportInBrowser(() => undefined);
    expect(res.entries.some((e) => e.path.endsWith(CREDITS_FILE))).toBe(false);
  });

  it("puts the credits of every CC BY sample into the project zip", async () => {
    await useSound(sound({ id: 5, license: "by" }), player, "sample", {
      open: false,
    });
    const blobs: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      blobs.push(b as Blob);
      return "blob:test";
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined
    );
    const { exportProjectZip } = await import("../src/project-actions.ts");
    await exportProjectZip();
    const zip = new Uint8Array(await (blobs[0] as Blob).arrayBuffer());
    const names = (await readZip(zip)).map((e) => e.path);
    expect(names).toContain(CREDITS_FILE);
    expect(names.some((n) => n.startsWith("samples/"))).toBe(true);
  });
});
