/* The assistant's hands in the studio: the real project, store, render worker path and delete dialog, with no model in
   the loop. Edits must be normal edits (undoable, one step per turn), measuring must return real numbers and pictures,
   and a delete must go through the studio's confirm dialog. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStudioHost } from "../src/assistant/host.ts";
import { toBase64 } from "../src/assistant/png.ts";
import type { Sfx } from "../src/lib/contract.ts";
import { defaultSfx } from "../src/lib/core.ts";
import { project } from "../src/state/docs.ts";
import { LocalStore, memoryBackend } from "../src/store/local.ts";
import { settle, until } from "./helpers.ts";

vi.setConfig({ testTimeout: 5000 });

let store: LocalStore;
beforeEach(async () => {
  store = new LocalStore(memoryBackend());
  project.setAutosave(false);
  await project.load(store);
  document.body.innerHTML = "";
});
afterEach(() => {
  document.body.innerHTML = "";
});

const ref = (id: string) => ({ id, kind: "sfx" as const });
const coin = () => project.get<Sfx>("sfx", "coin");

const withVolume = (v: number): Sfx => ({
  ...(structuredClone(coin()?.value) as Sfx),
  volume: v,
});

describe("reading", () => {
  it("lists documents with their detail and reads a copy of one", async () => {
    const host = createStudioHost();
    const list = await host.list("sfx");
    expect(list.length).toBeGreaterThan(0);
    expect(list.find((d) => d.id === "coin")).toMatchObject({
      detail: "coin",
      kind: "sfx",
    });
    const read = (await host.read(ref("coin"))) as Sfx;
    read.volume = 0.01;
    expect(coin()?.value.volume).not.toBe(0.01);
    expect(await host.read(ref("nope"))).toBeNull();
    expect((await host.project()).chip).toBe(project.project.chip);
  });
});

describe("writing", () => {
  it("creates a document that is stored, and edits an existing one in place", async () => {
    const host = createStudioHost();
    const fresh = { ...defaultSfx("nes"), name: "Fresh" };
    expect(await host.write(ref("fresh"), fresh)).toEqual({ created: true });
    expect(project.get("sfx", "fresh")?.value).toMatchObject({ name: "Fresh" });
    expect((await store.readJson("sfx/fresh.json")).json).toMatchObject({
      name: "Fresh",
    });
    expect(await host.write(ref("coin"), withVolume(0.33))).toEqual({
      created: false,
    });
    expect(coin()?.value.volume).toBe(0.33);
    expect(coin()?.dirty).toBe(true);
  });

  it("makes every write of a turn one undo step, and the next turn another", async () => {
    const host = createStudioHost();
    const doc = coin();
    const before = doc?.value.volume;
    host.beginTurn();
    await host.write(ref("coin"), withVolume(0.2));
    await host.write(ref("coin"), withVolume(0.3));
    await host.write(ref("coin"), withVolume(0.4));
    host.endTurn();
    host.beginTurn();
    await host.write(ref("coin"), withVolume(0.5));
    host.endTurn();
    expect(coin()?.value.volume).toBe(0.5);
    expect(project.undo(doc as NonNullable<typeof doc>)).toBe(true);
    expect(coin()?.value.volume).toBe(0.4);
    expect(project.undo(doc as NonNullable<typeof doc>)).toBe(true);
    expect(coin()?.value.volume).toBe(before);
    expect(doc?.history.canUndo).toBe(false);
    expect(project.redo(doc as NonNullable<typeof doc>)).toBe(true);
    expect(coin()?.value.volume).toBe(0.4);
  });

  it("does not merge a person's edit between turns into the turn", async () => {
    const host = createStudioHost();
    const doc = coin() as NonNullable<ReturnType<typeof coin>>;
    host.beginTurn();
    await host.write(ref("coin"), withVolume(0.2));
    project.edit<Sfx>(
      doc,
      (d) => {
        d.volume = 0.25;
      },
      "volume"
    );
    await host.write(ref("coin"), withVolume(0.3));
    host.endTurn();
    expect(project.undo(doc)).toBe(true);
    expect(coin()?.value.volume).toBe(0.25);
  });
});

describe("measuring", () => {
  it("renders and measures a sound, then draws pictures as real PNG files", async () => {
    const host = createStudioHost();
    const m = await host.analyze(ref("coin"));
    expect(m.analysis.duration).toBeGreaterThan(0.05);
    expect(m.analysis.peakDb).toBeLessThan(0.5);
    expect(m.imageKinds).toEqual(
      expect.arrayContaining(["waveform", "spectrogram"])
    );
    const pics = await host.images(ref("coin"), ["waveform", "spectrogram"]);
    expect(pics.map((p) => p.kind)).toEqual(["waveform", "spectrogram"]);
    for (const p of pics) {
      expect(p.mime).toBe("image/png");
      expect(p.width).toBeGreaterThan(100);
      // the base64 of the eight byte PNG signature
      expect(p.data.startsWith("iVBORw0KGgo")).toBe(true);
    }
  });

  it("refuses a document that does not exist", async () => {
    await expect(createStudioHost().analyze(ref("nope"))).rejects.toThrow(
      "does not exist"
    );
  });
});

describe("deleting", () => {
  const answer = async (primary: boolean) => {
    expect(await until(() => document.querySelector(".confirm") !== null)).toBe(
      true
    );
    const sel = primary
      ? ".confirm-btns .btn.primary"
      : ".confirm-btns .btn:not(.primary)";
    (document.querySelector(sel) as HTMLElement).click();
    await settle(5);
  };

  it("asks first and deletes only on yes", async () => {
    const host = createStudioHost();
    const no = host.remove(ref("coin"));
    await answer(false);
    expect(await no).toEqual({ deleted: false, missing: false });
    expect(coin()).toBeDefined();
    const yes = host.remove(ref("coin"));
    await answer(true);
    expect(await yes).toEqual({ deleted: true, missing: false });
    expect(coin()).toBeUndefined();
    expect(await host.remove(ref("coin"))).toEqual({
      deleted: false,
      missing: true,
    });
  });

  it("counts a stopped assistant as a no and closes the question", async () => {
    const host = createStudioHost();
    const stop = new AbortController();
    host.beginTurn(stop.signal);
    const pending = host.remove(ref("coin"));
    expect(await until(() => document.querySelector(".confirm") !== null)).toBe(
      true
    );
    stop.abort();
    expect(await pending).toEqual({ deleted: false, missing: false });
    expect(document.querySelector(".confirm")).toBeNull();
    expect(coin()).toBeDefined();
    host.endTurn();
  });
});

describe("pictures", () => {
  it("turns bytes into base64 in chunks", () => {
    const bytes = new Uint8Array(100_000).fill(65);
    expect(atob(toBase64(bytes))).toBe("A".repeat(100_000));
  });
});
