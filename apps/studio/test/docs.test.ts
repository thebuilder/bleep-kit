/* The project in memory (src/state/docs.ts) against a real LocalStore: what an edit does to the document and to the
   store, when a save happens, what a stale etag means, how an outside change is told from the studio's own write.
   This is the path that decides whether what the user shaped is kept. The view tests only see its effects. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sfx } from "../src/lib/contract.ts";
import { defaultSfx } from "../src/lib/core.ts";
import { type Doc, project } from "../src/state/docs.ts";
import { LocalStore, memoryBackend } from "../src/store/local.ts";
import type { ServerMessage } from "../src/store/store.ts";
import { settle, until } from "./helpers.ts";

let store: LocalStore;
/** The handlers the project subscribed to the store with, so a test can deliver a server message. */
let handlers: ((m: ServerMessage) => void)[] = [];
/** Stops the store from telling the project about writes (see the echo bug below), to test a save on its own. */
let silence: () => void = () => undefined;

beforeEach(async () => {
  store = new LocalStore(memoryBackend());
  handlers = [];
  const subscribe = store.subscribe.bind(store);
  const unsubs: (() => void)[] = [];
  silence = () => {
    for (const off of unsubs) {
      off();
    }
  };
  store.subscribe = (fn) => {
    handlers.push(fn);
    const off = subscribe(fn);
    unsubs.push(off);
    return off;
  };
  project.setAutosave(false);
  await project.load(store);
});

afterEach(() => {
  vi.useRealTimers();
  project.setAutosave(false);
});

const coin = () => project.get<Sfx>("sfx", "coin") as Doc<Sfx>;
const setVolume = (v: number, doc = coin()) =>
  project.edit<Sfx>(doc, (d) => {
    d.volume = v;
  });
const onDisk = async (path = "sfx/coin.json") =>
  (await store.readJson(path)).json as Sfx;
const STARTER_VOLUME = 0.6;

describe("saving what the user shaped", () => {
  it("keeps an edit in memory until it is saved, then writes it to the store", async () => {
    expect(coin().value.volume).toBe(STARTER_VOLUME);
    setVolume(0.31);
    expect(coin().value.volume).toBe(0.31);
    expect(coin().dirty).toBe(true);
    expect((await onDisk()).volume).toBe(STARTER_VOLUME);
    expect(await project.save(coin())).toBe(true);
    expect((await onDisk()).volume).toBe(0.31);
    expect(coin().dirty).toBe(false);
    expect(coin().etag).toBe((await store.readJson("sfx/coin.json")).etag);
  });

  it("writes nothing for a document that did not change", async () => {
    const write = vi.spyOn(store, "writeJson");
    expect(await project.save(coin())).toBe(true);
    setVolume(STARTER_VOLUME);
    expect(coin().dirty).toBe(false);
    expect(await project.save(coin())).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it("carries the etag it last saw with every save, so a stale one is caught", async () => {
    const write = vi.spyOn(store, "writeJson");
    const loadedEtag = coin().etag;
    expect(loadedEtag).toBeTruthy();
    setVolume(0.2);
    await project.save(coin());
    expect(write).toHaveBeenLastCalledWith(
      "sfx/coin.json",
      expect.objectContaining({ volume: 0.2 }),
      loadedEtag
    );
    const savedEtag = coin().etag;
    expect(savedEtag).not.toBe(loadedEtag);
    setVolume(0.3);
    await project.save(coin());
    expect(write).toHaveBeenLastCalledWith(
      "sfx/coin.json",
      expect.objectContaining({ volume: 0.3 }),
      savedEtag
    );
  });

  /* The store announces every write to the project, and the project takes the announcement's etag, so a save whose own
     etag handling was broken would be mended by the echo. With the echo off, a save has to leave the document holding the
     etag of what it wrote, or the next save is a conflict with itself. */
  it("keeps the etag a save returned, so the next save is not a conflict", async () => {
    silence();
    setVolume(0.2);
    expect(await project.save(coin())).toBe(true);
    expect(coin().etag).toBe((await store.readJson("sfx/coin.json")).etag);
    setVolume(0.3);
    expect(await project.save(coin())).toBe(true);
    expect(coin().conflict).toBeNull();
    expect((await onDisk()).volume).toBe(0.3);
  });

  it("saves what the document says after the edit was normalized, not what the edit asked for", async () => {
    setVolume(7);
    expect(coin().value.volume).toBe(1);
    await project.save(coin());
    expect((await onDisk()).volume).toBe(1);
  });

  it("undo goes back to the saved state without leaving the document marked changed, and redo forward", () => {
    setVolume(0.31);
    expect(project.undo(coin())).toBe(true);
    expect(coin().value.volume).toBe(STARTER_VOLUME);
    expect(coin().dirty).toBe(false);
    expect(project.undo(coin())).toBe(false);
    expect(project.redo(coin())).toBe(true);
    expect(coin().value.volume).toBe(0.31);
    expect(coin().dirty).toBe(true);
  });

  it("treats an undo after a save as a new change that still has to be saved", async () => {
    setVolume(0.31);
    await project.save(coin());
    project.undo(coin());
    expect(coin().dirty).toBe(true);
    await project.save(coin());
    expect((await onDisk()).volume).toBe(STARTER_VOLUME);
  });

  it("saves the project settings to project.json", async () => {
    expect(project.projectDirty).toBe(false);
    project.editProject((p) => {
      p.master.volume = 0.5;
    });
    expect(project.projectDirty).toBe(true);
    expect(await project.saveProject()).toBe(true);
    expect(project.projectDirty).toBe(false);
    const saved = (await store.readJson("project.json")).json as {
      master: { volume: number };
    };
    expect(saved.master.volume).toBe(0.5);
  });

  it("counts every unsaved document and the unsaved settings, and saveAll clears them", async () => {
    setVolume(0.31);
    const other = project.list("sfx").find((d) => d.id !== "coin") as Doc<Sfx>;
    setVolume(0.41, other);
    project.editProject((p) => {
      p.master.volume = 0.5;
    });
    expect(project.dirtyCount).toBe(3);
    await project.saveAll();
    expect(project.dirtyCount).toBe(0);
    expect((await onDisk()).volume).toBe(0.31);
    expect((await onDisk(other.path)).volume).toBe(0.41);
  });
});

describe("autosave", () => {
  const writes = () => vi.spyOn(store, "writeJson");

  it("saves 800 ms after the last change, and waits longer while the user keeps changing it", async () => {
    vi.useFakeTimers();
    project.setAutosave(true);
    const write = writes();
    setVolume(0.2);
    await vi.advanceTimersByTimeAsync(500);
    setVolume(0.3);
    await vi.advanceTimersByTimeAsync(799);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(write).toHaveBeenCalledTimes(1);
    expect((await onDisk()).volume).toBe(0.3);
    expect(coin().dirty).toBe(false);
  });

  it("saves nothing while it is off, and catches up when it is turned on", async () => {
    vi.useFakeTimers();
    const write = writes();
    setVolume(0.2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(write).not.toHaveBeenCalled();
    project.setAutosave(true);
    await vi.advanceTimersByTimeAsync(801);
    expect(write).toHaveBeenCalledTimes(1);
    expect((await onDisk()).volume).toBe(0.2);
  });

  it("does not bring a deleted document back when its save was already scheduled", async () => {
    vi.useFakeTimers();
    project.setAutosave(true);
    setVolume(0.2);
    await project.remove(coin());
    await vi.advanceTimersByTimeAsync(2000);
    await expect(store.readJson("sfx/coin.json")).rejects.toThrow();
  });

  it("saves settings changes too", async () => {
    vi.useFakeTimers();
    project.setAutosave(true);
    project.editProject((p) => {
      p.master.volume = 0.5;
    });
    await vi.advanceTimersByTimeAsync(801);
    expect(
      ((await store.readJson("project.json")).json as { master: unknown })
        .master
    ).toMatchObject({ volume: 0.5 });
  });
});

describe("changes made behind the studio's back", () => {
  const theirs = async (volume: number) => {
    const json = { ...(await onDisk()), volume };
    await store.writeJson("sfx/coin.json", json);
    return json;
  };

  it("takes an outside change silently when the document has no unsaved edits", async () => {
    await theirs(0.9);
    expect(await until(() => coin().value.volume === 0.9)).toBe(true);
    expect(coin().dirty).toBe(false);
    expect(coin().conflict).toBeNull();
    expect(coin().flashAt).toBeGreaterThan(0);
  });

  it("raises a conflict instead of overwriting unsaved edits, and keeps the edits", async () => {
    setVolume(0.31);
    await theirs(0.9);
    expect(await until(() => coin().conflict !== null)).toBe(true);
    expect(coin().value.volume).toBe(0.31);
    expect(coin().conflict).toMatchObject({ json: { volume: 0.9 } });
  });

  it("refuses to save over an outside change, and Keep mine overwrites it", async () => {
    setVolume(0.31);
    await theirs(0.9);
    expect(await project.save(coin())).toBe(false);
    expect(coin().conflict).not.toBeNull();
    expect((await onDisk()).volume).toBe(0.9);
    expect(await project.keepMine(coin())).toBe(true);
    expect(coin().conflict).toBeNull();
    expect((await onDisk()).volume).toBe(0.31);
  });

  it("Reload takes the outside version and drops the unsaved edits", async () => {
    setVolume(0.31);
    await theirs(0.9);
    await project.save(coin());
    project.reload(coin());
    expect(coin().value.volume).toBe(0.9);
    expect(coin().dirty).toBe(false);
    expect(coin().conflict).toBeNull();
    // and the reload is something undo can step back from
    expect(project.undo(coin())).toBe(true);
  });

  it("adds a document that appeared outside, and forgets one that was deleted", async () => {
    await store.writeJson("sfx/from-outside.json", {
      ...defaultSfx("nes"),
      name: "From outside",
    });
    expect(
      await until(() => project.get("sfx", "from-outside") !== undefined)
    ).toBe(true);
    await store.remove("sfx/from-outside.json");
    expect(project.get("sfx", "from-outside")).toBeUndefined();
  });

  it("hands a play request from the CLI to whoever listens", () => {
    const plays: [string, boolean][] = [];
    project.onRemotePlay = (ref, visual) => plays.push([ref, visual]);
    handlers[0]?.({ ref: "sfx/coin", type: "play", visual: true });
    handlers[0]?.({ ref: "song/theme", type: "play", visual: false });
    expect(plays).toEqual([
      ["sfx/coin", true],
      ["song/theme", false],
    ]);
  });

  it("passes server warnings and errors on to the log", () => {
    const log: [string, string][] = [];
    project.onLog = (level, message) => log.push([level, message]);
    handlers[0]?.({ level: "warn", message: "careful", type: "log" });
    expect(log).toEqual([["warn", "careful"]]);
  });

  /* KNOWN BUG, see the audit ledger. The LocalStore announces a write to its subscribers before writeJson returns, so
     the project sees the "file" message while it still holds the old etag, takes the studio's own save for an outside
     edit and reads the file back. Every standalone save then flashes the sidebar row, and an edit made while the save is
     in flight (a slider being dragged) raises a false "changed on disk" conflict against the studio's own write. The
     same echo makes create() ingest a new document twice, so the Doc it returns is replaced in the list by a second
     copy. The server store is not affected: its file message arrives after the PUT has been answered. These two tests
     state the correct behavior and are expected to fail until docs.ts ignores the echo of its own write. */
  it.fails("does not mistake its own save for an outside change", async () => {
    const causes: string[] = [];
    project.subscribe((e) => {
      if (e.type === "doc") {
        causes.push(e.cause);
      }
    });
    setVolume(0.31);
    await project.save(coin());
    await settle(100);
    expect(causes).not.toContain("external");
    expect(coin().flashAt).toBe(0);
  });

  it.fails("keeps editing during a save from turning into a conflict with itself", async () => {
    setVolume(0.32);
    const saving = project.save(coin());
    setVolume(0.33);
    await saving;
    await settle(100);
    expect(coin().conflict).toBeNull();
    expect(coin().value.volume).toBe(0.33);
  });
});

describe("creating, copying and deleting documents", () => {
  it("writes a new document to the store and lists it", async () => {
    const made = await project.create("sfx", "fresh", defaultSfx("nes"));
    expect(project.get("sfx", "fresh")?.path).toBe(made.path);
    expect(made.etag).toBeTruthy();
    expect(made.dirty).toBe(false);
    expect((await onDisk("sfx/fresh.json")).chip).toBe("nes");
  });

  it("makes ids from names that cannot collide", () => {
    expect(project.uniqueId("sfx", "Coin")).toBe("coin-2");
    expect(project.uniqueId("sfx", "Laser Zap!!")).toBe("laser-zap");
    expect(project.uniqueId("sfx", "???")).toBe("sfx");
  });

  it("copies a document under a new id, name and store file, leaving the original alone", async () => {
    const copy = await project.duplicate(coin());
    expect(copy.id).toBe("coin-copy");
    expect((copy.value as Sfx).name).toBe(`${coin().value.name} copy`);
    expect((await onDisk("sfx/coin-copy.json")).name).toBe(
      `${coin().value.name} copy`
    );
    project.edit<Sfx>(copy as Doc<Sfx>, (d) => {
      d.volume = 0.11;
    });
    expect(coin().value.volume).toBe(STARTER_VOLUME);
  });

  it("deletes a document from the store as well as the list", async () => {
    await project.remove(coin());
    expect(project.get("sfx", "coin")).toBeUndefined();
    await expect(store.readJson("sfx/coin.json")).rejects.toThrow();
  });

  it("finds a document by kind and id, or by id alone", () => {
    expect(project.find("sfx/coin")?.path).toBe("sfx/coin.json");
    expect(project.find("coin")?.path).toBe("sfx/coin.json");
    expect(project.find("song/starter-theme")?.kind).toBe("song");
    expect(project.find("sfx/starter-theme")).toBeUndefined();
    expect(project.find("nothing-like-it")).toBeUndefined();
  });
});
