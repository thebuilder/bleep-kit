/* Copying examples into the user's project. A song brings every instrument it uses; an id the project already has gets
   the next free one (`boss-hall-2`, `snes-bass-2`) and the song's references are remapped to the copies. The plan is
   pure (ids in, documents out) so it can be checked on its own; `addToProject` writes it through the project, which
   writes through the ProjectStore (the browser's own, or the CLI server). */
import type { Instrument, Sfx, Song } from "../lib/contract.ts";
import { type Doc, type DocKind, project } from "../state/docs.ts";
import { ID_RE } from "../store/store.ts";
import type { ExampleCatalog, ExampleSfx, ExampleSong } from "./catalog.ts";

const MML_INSTRUMENT = /@([A-Za-z0-9-]+)/g;
const ID_MAX = 64;

/** One document to create. `from` is the example it came from. */
export interface PlannedDoc {
  from: string;
  id: string;
  kind: DocKind;
  value: Instrument | Sfx | Song;
}

export interface CopyPlan {
  /** Instruments first, then songs, then sound effects: a song is normalized against the instruments it names. */
  docs: PlannedDoc[];
  /** The example instrument id to the id of its copy. */
  instruments: Map<string, string>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** `base` if it is free, else `base-2`, `base-3`, ... (the id rules of the project hold: 64 characters at most). */
export function freeId(base: string, taken: (id: string) => boolean): string {
  let id = base;
  for (let n = 2; taken(id) || !ID_RE.test(id); n += 1) {
    const suffix = `-${n}`;
    id = `${base.slice(0, ID_MAX - suffix.length)}${suffix}`;
  }
  return id;
}

/** A copy of `song` that names the instruments in `ids` by their new ids: channel defaults, MML `@id` switches, rows. */
export function remapSong(song: Song, ids: ReadonlyMap<string, string>): Song {
  const out = clone(song);
  const swap = (id: string) => ids.get(id) ?? id;
  for (const channel of out.channels) {
    if (channel.instrument) {
      channel.instrument = swap(channel.instrument);
    }
    if (channel.mml) {
      channel.mml = channel.mml.replace(
        MML_INSTRUMENT,
        (_all, id: string) => `@${swap(id)}`
      );
    }
  }
  for (const pattern of Object.values(out.patterns)) {
    for (const row of Object.values(pattern.tracks).flat()) {
      if (row.inst) {
        row.inst = swap(row.inst);
      }
    }
  }
  return out;
}

/** What to copy: songs (with the instruments they use), sound effects, and instruments that no song needs (by id). */
export interface CopyPick {
  instruments?: readonly string[];
  sfx?: readonly ExampleSfx[];
  songs?: readonly ExampleSong[];
}

/**
 * What it takes to copy `pick` of the catalog into a project that already holds the ids `has` says it does. An
 * instrument two songs share is copied once. Ids taken by earlier items of the plan count as taken.
 */
export function planCopy(
  catalog: ExampleCatalog,
  pick: CopyPick,
  has: (kind: DocKind, id: string) => boolean
): CopyPlan {
  const planned = new Set<string>();
  const claim = (kind: DocKind, base: string): string => {
    const id = freeId(base, (c) => has(kind, c) || planned.has(`${kind}/${c}`));
    planned.add(`${kind}/${id}`);
    return id;
  };
  const songs = pick.songs ?? [];
  const instruments = new Map<string, string>();
  const docs: PlannedDoc[] = [];
  const wanted = [
    ...songs.flatMap((ex) => ex.instrumentIds),
    ...(pick.instruments ?? []),
  ];
  for (const id of wanted) {
    const inst = catalog.instruments[id];
    if (inst && !instruments.has(id)) {
      const copy = claim("instrument", id);
      instruments.set(id, copy);
      docs.push({ from: id, id: copy, kind: "instrument", value: clone(inst) });
    }
  }
  for (const ex of songs) {
    docs.push({
      from: ex.id,
      id: claim("song", ex.id),
      kind: "song",
      value: remapSong(ex.song, instruments),
    });
  }
  for (const ex of pick.sfx ?? []) {
    docs.push({
      from: ex.id,
      id: claim("sfx", ex.id),
      kind: "sfx",
      value: clone(ex.sfx),
    });
  }
  return { docs, instruments };
}

/**
 * Copy examples into the open project, in the plan's order: each document is written before the next one is planned
 * against it, so a song finds its instruments in the project.
 */
export async function addToProject(
  catalog: ExampleCatalog,
  pick: CopyPick
): Promise<{ docs: Doc[]; plan: CopyPlan }> {
  const plan = planCopy(
    catalog,
    pick,
    (kind, id) => project.get(kind, id) !== undefined
  );
  const docs: Doc[] = [];
  for (const d of plan.docs) {
    // biome-ignore lint/performance/noAwaitInLoops: a song is normalized against the instruments created before it
    docs.push(await project.create(d.kind, d.id, d.value));
  }
  return { docs, plan };
}
