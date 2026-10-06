/* The examples the studio ships with: examples/demo, bundled at build time. The folder stays the single source of
   truth (nothing is copied into apps/studio), so the studio always shows the current demo project. The documents are
   raw JSON, as the CLI reads them; `exampleCatalog()` normalizes them the way the project does and works out what the
   cards show (tempo, length, the game style a chip stands for, which instruments a song needs). */

import { chipTheme } from "../lib/chips.ts";
import {
  CHIP_IDS,
  type ChipId,
  type Instrument,
  PPQ,
  type Sfx,
  type Song,
} from "../lib/contract.ts";
import {
  compileSong,
  normalizeInstrument,
  normalizeSfx,
  normalizeSong,
} from "../lib/core.ts";

/* Vite inlines these at build time. The paths climb out of apps/studio to the repository's demo project. */
const RAW_SONGS = import.meta.glob("../../../../examples/demo/songs/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;
const RAW_SFX = import.meta.glob("../../../../examples/demo/sfx/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;
const RAW_INSTRUMENTS = import.meta.glob(
  "../../../../examples/demo/instruments/*.json",
  { eager: true, import: "default" }
) as Record<string, unknown>;

/** The kind of game each chip's examples were made for: the demo has one set per chip. */
export const GAME_STYLES: Record<ChipId, string> = {
  adlib: "Dark-fantasy shooter",
  c64: "Arcade chase",
  custom: "Anything goes",
  gameboy: "Handheld adventure",
  genesis: "Space trader",
  nes: "Grid deckbuilder",
  snes: "Soulslike action RPG",
};

export interface ExampleSong {
  chip: ChipId;
  /** The part of the name in parentheses (key, tempo, flavour), or "". */
  detail: string;
  id: string;
  /** Ids of the example instruments the song uses (channel defaults, row switches, MML `@id`). */
  instrumentIds: string[];
  name: string;
  /** One pass through the song (the order list once, tempo changes included). */
  seconds: number;
  song: Song;
  style: string;
  tempo: number;
}

export interface ExampleSfx {
  category: Sfx["category"];
  chip: ChipId;
  detail: string;
  id: string;
  name: string;
  sfx: Sfx;
  style: string;
}

/** The sound effects of one chip's set. */
export interface ExampleSet {
  chip: ChipId;
  sfx: ExampleSfx[];
  style: string;
  title: string;
}

export interface ExampleCatalog {
  /** Every instrument of the demo, by id. */
  instruments: Record<string, Instrument>;
  /** The sound effects, grouped by set in the order of the chips. */
  sets: ExampleSet[];
  sfx: ExampleSfx[];
  songs: ExampleSong[];
}

const PAREN = /\s*\(([^)]*)\)\s*/;

/** "Boss Hall (SNES samples, D minor)" is a name and a detail; whatever follows the parentheses stays in the name. */
export function splitName(full: string): { detail: string; name: string } {
  const m = PAREN.exec(full);
  return m
    ? {
        detail: m[1] ?? "",
        name: `${full.slice(0, m.index)} ${full.slice(m.index + m[0].length)}`.trim(),
      }
    : { detail: "", name: full };
}

const JSON_EXT = /\.json$/;
const idOf = (path: string): string =>
  (path.split("/").pop() ?? "").replace(JSON_EXT, "");
const chipRank = (chip: ChipId): number => CHIP_IDS.indexOf(chip);
const MML_INSTRUMENT = /@([A-Za-z0-9-]+)/g;

/** Every instrument id a song uses: channel defaults, row `inst` fields and MML `@id` switches. */
export function referencedInstruments(song: Song): string[] {
  const fromChannels = song.channels.flatMap((c) => [
    c.instrument ?? "",
    ...[...(c.mml ?? "").matchAll(MML_INSTRUMENT)].map((m) => m[1] ?? ""),
  ]);
  const fromRows = Object.values(song.patterns).flatMap((pattern) =>
    Object.values(pattern.tracks)
      .flat()
      .map((row) => row.inst ?? "")
  );
  return [...new Set([...fromChannels, ...fromRows].filter(Boolean))].sort();
}

/** Seconds of one pass through a song, following its tempo changes. */
function songSeconds(
  song: Song,
  instruments: Record<string, Instrument>
): number {
  const tl = compileSong(song, instruments);
  let seconds = 0;
  for (const [i, [from, bpm]] of tl.tempos.entries()) {
    const to = Math.min(
      tl.totalPulses,
      tl.tempos[i + 1]?.[0] ?? Number.POSITIVE_INFINITY
    );
    seconds += (Math.max(0, to - from) * 60) / (bpm * PPQ);
  }
  return seconds;
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id);
}

function build(): ExampleCatalog {
  const instruments: Record<string, Instrument> = {};
  for (const [path, json] of Object.entries(RAW_INSTRUMENTS)) {
    instruments[idOf(path)] = normalizeInstrument(json).value;
  }
  const songs = Object.entries(RAW_SONGS)
    .map(([path, json]): ExampleSong => {
      const song = normalizeSong(json, instruments).value;
      const { detail, name } = splitName(song.name);
      return {
        chip: song.chip,
        detail,
        id: idOf(path),
        instrumentIds: referencedInstruments(song).filter(
          (id) => id in instruments
        ),
        name,
        seconds: songSeconds(song, instruments),
        song,
        style: GAME_STYLES[song.chip],
        tempo: song.tempo,
      };
    })
    .sort((a, b) => chipRank(a.chip) - chipRank(b.chip) || byId(a, b));
  const sfx = Object.entries(RAW_SFX)
    .map(([path, json]): ExampleSfx => {
      const { value } = normalizeSfx(json);
      const { detail, name } = splitName(value.name);
      return {
        category: value.category,
        chip: value.chip,
        detail,
        id: idOf(path),
        name,
        sfx: value,
        style: GAME_STYLES[value.chip],
      };
    })
    .sort((a, b) => chipRank(a.chip) - chipRank(b.chip) || byId(a, b));
  const sets: ExampleSet[] = [];
  for (const s of sfx) {
    let set = sets.find((x) => x.chip === s.chip);
    if (!set) {
      set = {
        chip: s.chip,
        sfx: [],
        style: s.style,
        title: chipTheme(s.chip).short,
      };
      sets.push(set);
    }
    set.sfx.push(s);
  }
  return { instruments, sets, sfx, songs };
}

let cached: ExampleCatalog | null = null;

/** The bundled demo project, normalized once on first use. */
export function exampleCatalog(): ExampleCatalog {
  cached ??= build();
  return cached;
}
