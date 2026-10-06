// @vitest-environment node
/// <reference types="node" />
/* The examples the studio bundles from examples/demo, and copying them into a project: the list is the folder (nothing
   is dropped, nothing is copied by hand), and an id the project already has gets a free one with the song's
   instrument references following the copies. */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ExampleCatalog,
  type ExampleSong,
  exampleCatalog,
  GAME_STYLES,
  referencedInstruments,
  splitName,
} from "../src/examples/catalog.ts";
import {
  addToProject,
  freeId,
  planCopy,
  remapSong,
} from "../src/examples/copy.ts";
import type { Instrument, Song } from "../src/lib/contract.ts";
import { defaultInstrument, defaultSong } from "../src/lib/core.ts";
import { project } from "../src/state/docs.ts";
import { LocalStore, memoryBackend } from "../src/store/local.ts";

const DEMO = fileURLToPath(new URL("../../../examples/demo/", import.meta.url));
const idsIn = (dir: string) =>
  readdirSync(`${DEMO}${dir}`)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();

let catalog: ExampleCatalog;
beforeAll(() => {
  catalog = exampleCatalog();
});

describe("the bundled examples", () => {
  it("are the documents of examples/demo: every song, sound effect and instrument, and nothing else", () => {
    expect(catalog.songs.map((s) => s.id).sort()).toEqual(idsIn("songs"));
    expect(catalog.sfx.map((s) => s.id).sort()).toEqual(idsIn("sfx"));
    expect(Object.keys(catalog.instruments).sort()).toEqual(
      idsIn("instruments")
    );
    // six songs, one per chip, and the 22 sound effects the demo documents
    expect(catalog.songs).toHaveLength(6);
    expect(new Set(catalog.songs.map((s) => s.chip)).size).toBe(6);
    expect(catalog.sfx).toHaveLength(22);
  });

  it("groups the sound effects into sets that hold every one of them once, each with a game style", () => {
    expect(
      catalog.sets.flatMap((set) => set.sfx.map((s) => s.id)).sort()
    ).toEqual(catalog.sfx.map((s) => s.id).sort());
    for (const set of catalog.sets) {
      expect(set.style).toBe(GAME_STYLES[set.chip]);
      expect(set.sfx.every((s) => s.chip === set.chip)).toBe(true);
    }
    for (const song of catalog.songs) {
      expect(song.style).toBe(GAME_STYLES[song.chip]);
    }
  });

  it("describe each song with its tempo and length, and know which instruments it needs", () => {
    for (const ex of catalog.songs) {
      expect(ex.tempo).toBe(ex.song.tempo);
      expect(ex.seconds).toBeGreaterThan(5);
      expect(ex.seconds).toBeLessThan(600);
      expect(ex.instrumentIds.length).toBeGreaterThan(0);
      for (const id of ex.instrumentIds) {
        expect(catalog.instruments[id], `${ex.id} uses ${id}`).toBeDefined();
      }
    }
  });

  it("splits 'Name (detail)'", () => {
    expect(splitName("Boss Hall (SNES samples, D minor)")).toEqual({
      detail: "SNES samples, D minor",
      name: "Boss Hall",
    });
    expect(splitName("Footstep (low thud) alt-1")).toEqual({
      detail: "low thud",
      name: "Footstep alt-1",
    });
    expect(splitName("Plain")).toEqual({ detail: "", name: "Plain" });
  });
});

/** A song with two instruments whose ids are prefixes of each other, named from a channel, MML and a pattern row. */
function twoLeads(): { instruments: Record<string, Instrument>; song: Song } {
  const song = defaultSong("nes");
  const [first, second] = song.channels;
  if (!(first && second)) {
    throw new Error("the default song has channels");
  }
  first.instrument = "lead";
  first.mml = "o4 c4 @lead-2 d4 @lead e4";
  second.instrument = "lead-2";
  song.patterns = {
    a: {
      length: 4,
      tracks: {
        [second.id]: [{ fx: [], inst: "lead-2", note: 60, row: 0, vol: null }],
      },
    },
  };
  song.order = ["a"];
  return {
    instruments: {
      lead: defaultInstrument("pulse", "nes"),
      "lead-2": defaultInstrument("pulse", "nes"),
    },
    song,
  };
}

function exampleOf(
  id: string,
  song: Song,
  instruments: Record<string, Instrument>
): { catalog: ExampleCatalog; song: ExampleSong } {
  const ex: ExampleSong = {
    chip: "nes",
    detail: "",
    id,
    instrumentIds: referencedInstruments(song),
    name: id,
    seconds: 1,
    song,
    style: "",
    tempo: song.tempo,
  };
  return { catalog: { instruments, sets: [], sfx: [], songs: [ex] }, song: ex };
}

describe("copying with clashing ids", () => {
  it("picks the next free id", () => {
    expect(freeId("a", () => false)).toBe("a");
    expect(freeId("a", (id) => id === "a")).toBe("a-2");
    expect(freeId("a", (id) => id === "a" || id === "a-2")).toBe("a-3");
    const long = "x".repeat(64);
    expect(freeId(long, (id) => id === long)).toHaveLength(64);
  });

  it("remaps the instrument references of a song to the copies, by whole id", () => {
    const { song } = twoLeads();
    const out = remapSong(
      song,
      new Map([
        ["lead", "lead-9"],
        ["lead-2", "lead-2-2"],
      ])
    );
    expect(out.channels[0]?.instrument).toBe("lead-9");
    expect(out.channels[0]?.mml).toBe("o4 c4 @lead-2-2 d4 @lead-9 e4");
    expect(out.channels[1]?.instrument).toBe("lead-2-2");
    expect(Object.values(out.patterns.a?.tracks ?? {})[0]?.[0]?.inst).toBe(
      "lead-2-2"
    );
    // the example itself is not changed
    expect(song.channels[0]?.instrument).toBe("lead");
  });

  it("gives clashing songs and instruments free ids and points the song at the copies", () => {
    const { instruments, song } = twoLeads();
    const { catalog: small, song: ex } = exampleOf("tune", song, instruments);
    const taken = new Set(["song/tune", "instrument/lead", "instrument/other"]);
    const plan = planCopy(small, { songs: [ex] }, (kind, id) =>
      taken.has(`${kind}/${id}`)
    );
    // lead is taken, lead-2 is free: the copy of lead takes lead-2, so the copy of lead-2 moves on to lead-2-2
    expect(Object.fromEntries(plan.instruments)).toEqual({
      lead: "lead-2",
      "lead-2": "lead-2-2",
    });
    expect(plan.docs.map((d) => `${d.kind}/${d.id}`)).toEqual([
      "instrument/lead-2",
      "instrument/lead-2-2",
      "song/tune-2",
    ]);
    const copy = plan.docs.at(-1)?.value as Song;
    expect(referencedInstruments(copy)).toEqual(["lead-2", "lead-2-2"]);
    expect(copy.channels[0]?.mml).toBe("o4 c4 @lead-2-2 d4 @lead-2 e4");
  });

  it("copies an instrument two songs share once, and a whole demo with ids that never collide", () => {
    const { instruments, song } = twoLeads();
    const a = exampleOf("a", song, instruments);
    const b = exampleOf("b", structuredClone(song), instruments);
    const plan = planCopy(
      { ...a.catalog, songs: [a.song, b.song] },
      { songs: [a.song, b.song] },
      () => false
    );
    expect(plan.docs.filter((d) => d.kind === "instrument")).toHaveLength(2);
    const all = planCopy(
      catalog,
      {
        instruments: Object.keys(catalog.instruments),
        sfx: catalog.sfx,
        songs: catalog.songs,
      },
      () => false
    );
    const paths = all.docs.map((d) => `${d.kind}/${d.id}`);
    expect(new Set(paths).size).toBe(paths.length);
    expect(all.docs.filter((d) => d.kind === "instrument")).toHaveLength(
      Object.keys(catalog.instruments).length
    );
    expect(all.docs.filter((d) => d.kind === "sfx")).toHaveLength(22);
    expect(all.docs.filter((d) => d.kind === "song")).toHaveLength(6);
  });
});

describe("adding to a project", () => {
  it("writes a song with its instruments, and a second add lands beside the first, each song playing its own copies", async () => {
    await project.load(new LocalStore(memoryBackend()));
    // the starter kit already holds snes-bass, which Boss Hall uses
    expect(project.get("instrument", "snes-bass")).toBeDefined();
    const starterBass = JSON.stringify(
      project.get("instrument", "snes-bass")?.value
    );
    const bossHall = catalog.songs.find(
      (s) => s.id === "boss-hall"
    ) as ExampleSong;

    const first = await addToProject(catalog, { songs: [bossHall] });
    expect(first.docs.map((d) => d.kind)).toContain("song");
    expect(project.get("song", "boss-hall")).toBeDefined();
    expect(first.plan.instruments.get("snes-bass")).toBe("snes-bass-2");

    const second = await addToProject(catalog, { songs: [bossHall] });
    expect(project.get("song", "boss-hall-2")).toBeDefined();
    expect(second.plan.instruments.get("snes-bass")).toBe("snes-bass-3");

    // the starter's own instrument is untouched, and every song names instruments the project has
    expect(JSON.stringify(project.get("instrument", "snes-bass")?.value)).toBe(
      starterBass
    );
    for (const id of ["boss-hall", "boss-hall-2"]) {
      const doc = project.get("song", id);
      expect(doc?.issues.filter((i) => i.severity === "error")).toEqual([]);
      for (const ref of referencedInstruments(doc?.value as Song)) {
        expect(
          project.get("instrument", ref),
          `${id} uses ${ref}`
        ).toBeDefined();
      }
    }
    expect(
      referencedInstruments(project.get("song", "boss-hall-2")?.value as Song)
    ).toContain("snes-bass-3");
    // it reached the store, not only memory
    expect(
      (await project.store.readJson("songs/boss-hall-2.json")).json
    ).toEqual(project.get("song", "boss-hall-2")?.value);
  });

  it("adds a sound effect alone, under a free id", async () => {
    const ex = catalog.sfx.find((s) => s.id === "grid-hit");
    expect(ex).toBeDefined();
    if (!ex) {
      return;
    }
    const a = await addToProject(catalog, { sfx: [ex] });
    const b = await addToProject(catalog, { sfx: [ex] });
    expect(a.docs.map((d) => d.id)).toEqual(["grid-hit"]);
    expect(b.docs.map((d) => d.id)).toEqual(["grid-hit-2"]);
    expect(a.plan.instruments.size).toBe(0);
    expect(project.get("sfx", "grid-hit-2")?.value).toEqual(ex.sfx);
  });
});
