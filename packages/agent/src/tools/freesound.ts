// The Freesound tools: search the sample library and import one result as a user sample. They exist only when the host
// has a Freesound browser (host.freesound). The model never hears a sound or sees its audio: it picks from names, tags,
// lengths, detected notes and licenses, imports by id, and then uses the sample like any other (set_instrument_sample).
// Only CC0 and CC BY sounds come back; a CC BY sound is credited in CREDITS.txt of the exports, and the tool says so.
import {
  type AgentHost,
  type FreesoundHit,
  type FreesoundSearchOptions,
  isDocId,
} from "../host.ts";
import { type AgentTool, defineTool, done, fail } from "../tool-kit.ts";

const MAX_HITS = 12;

function hitLine(hit: FreesoundHit): string {
  const bits = [
    `${hit.seconds} s`,
    hit.oneShot ? "one-shot" : "not a one-shot",
    hit.note ? `note ${hit.note}` : "no clear note",
    hit.license,
  ];
  const tags = hit.tags.slice(0, 6).join(", ");
  return `${hit.id}: "${hit.name}" by ${hit.author} (${bits.join(", ")})${tags ? ` [${tags}]` : ""}`;
}

interface SearchInput {
  license?: "by" | "cc0";
  max_seconds?: number;
  one_shot?: boolean;
  page?: number;
  query?: string;
  sort?: NonNullable<FreesoundSearchOptions["sort"]>;
  subcategory?: NonNullable<FreesoundSearchOptions["subcategory"]>;
  tags?: string[];
}

function searchOptions(input: SearchInput): FreesoundSearchOptions {
  return {
    ...(input.license === undefined ? {} : { license: input.license }),
    ...(input.max_seconds === undefined
      ? {}
      : { maxSeconds: input.max_seconds }),
    ...(input.one_shot === undefined ? {} : { oneShot: input.one_shot }),
    ...(input.page === undefined ? {} : { page: input.page }),
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.sort === undefined ? {} : { sort: input.sort }),
    ...(input.subcategory === undefined
      ? {}
      : { subcategory: input.subcategory }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
  };
}

function searchTool(free: NonNullable<AgentHost["freesound"]>): AgentTool {
  return defineTool<SearchInput>({
    description:
      'Search Freesound.org for instrument samples (its category Instrument samples). Returns up to 12 sounds per page with id, name, author, length, detected note, one-shot flag, license and tags. Only CC0 (no credit needed) is searched unless license is "by", which also returns CC BY sounds (the person must credit them; the studio writes CREDITS.txt into exports). You cannot hear the results, so judge them by name, tags, length and note, and import the best one or two with import_freesound_sample. Short one-shots suit drums and hits; sounds with a detected note suit melodic instruments.',
    inputSchema: {
      properties: {
        license: {
          description: 'Default "cc0". "by" adds CC BY sounds.',
          enum: ["cc0", "by"],
          type: "string",
        },
        max_seconds: {
          description:
            "Longest sound wanted, in seconds: 0.5, 1, 2 or 5 (another value is rounded up to the next of these; above 5 means no limit up to 20 s).",
          maximum: 20,
          minimum: 0.1,
          type: "number",
        },
        one_shot: {
          description:
            "Only sounds Freesound marks as a single event (a hit, not a loop or a texture).",
          type: "boolean",
        },
        page: {
          description: "Page of results, from 1.",
          minimum: 1,
          type: "integer",
        },
        query: {
          description:
            "Words to search for, such as kick, 808, laser or marimba.",
          maxLength: 80,
          type: "string",
        },
        sort: {
          description: 'Default "relevance".',
          enum: ["relevance", "shortest", "rating", "downloads"],
          type: "string",
        },
        subcategory: {
          description: "Kind of instrument sample.",
          enum: ["percussion", "string", "wind", "keys", "synth", "other"],
          type: "string",
        },
        tags: {
          description:
            "Up to 4 lowercase tags that all must match, such as 8-bit or snare.",
          items: { type: "string" },
          maxItems: 4,
          type: "array",
        },
      },
      type: "object",
    },
    name: "search_freesound",
    run: async (input) => {
      try {
        const out = await free.search(searchOptions(input));
        if (out.hits.length === 0) {
          return done(
            "No Freesound results",
            `Nothing matched.${out.notes.length > 0 ? ` ${out.notes.join(" ")}` : ""} Try fewer tags, another subcategory or a longer max_seconds.`
          );
        }
        const shown = out.hits.slice(0, MAX_HITS).map(hitLine);
        return done(
          `${out.count} Freesound sound${out.count === 1 ? "" : "s"}`,
          `${shown.join("\n")}\n${out.hasMore ? "More on the next page." : "That is all."}${out.notes.length > 0 ? ` ${out.notes.join(" ")}` : ""} Import with import_freesound_sample.`
        );
      } catch (error) {
        return fail("Freesound search failed", (error as Error).message);
      }
    },
  });
}

interface ImportInput {
  id: number;
  instrument?: string;
}

function importTool(
  host: AgentHost,
  free: NonNullable<AgentHost["freesound"]>
): AgentTool {
  return defineTool<ImportInput>({
    description:
      "Import a sound that search_freesound returned in this conversation as a user sample. The sample keeps its author, link and license (the studio shows them, and a CC BY sound is credited in CREDITS.txt when it is exported). The audio is Freesound's preview MP3, made mono and level, converted for the project's chip. With instrument set to an id, a sample instrument that plays it is made as well, ready for a song channel. Only ids a search returned can be imported.",
    inputSchema: {
      properties: {
        id: {
          description: "The Freesound id from search_freesound.",
          minimum: 1,
          type: "integer",
        },
        instrument: {
          description:
            "Also make a sample instrument with this id (lowercase letters, digits, dashes).",
          type: "string",
        },
      },
      required: ["id"],
      type: "object",
    },
    name: "import_freesound_sample",
    run: async ({ id, instrument }) => {
      if (instrument !== undefined && !isDocId(instrument)) {
        return fail(
          "Bad id",
          `"${instrument}" is not a valid instrument id: lowercase letters, digits and dashes.`
        );
      }
      if (
        instrument !== undefined &&
        (await host.read({ id: instrument, kind: "instrument" }))
      ) {
        return fail(
          `instrument/${instrument} exists`,
          `There is already an instrument "${instrument}". Pick another id, or import without instrument and use set_instrument_sample.`
        );
      }
      try {
        const got = await free.import(id, { instrument: instrument ?? null });
        const credit =
          got.hit.license === "CC BY"
            ? " It is CC BY: tell the person it needs credit, and that the exports list it in CREDITS.txt."
            : " It is CC0: no credit is needed.";
        const made = got.instrument
          ? ` Made instrument/${got.instrument} to play it; use it in a song like any sample instrument.`
          : " set_instrument_sample makes an instrument play it.";
        return done(
          `sample/${got.sample.id}`,
          `Imported "${got.hit.name}" by ${got.hit.author} as sample/${got.sample.id}: ${got.sample.bits} bit mono ${got.sample.rate} Hz, ${got.sample.seconds} s, base note ${got.sample.baseNote}.${credit}${made}`
        );
      } catch (error) {
        return fail("Cannot import", (error as Error).message);
      }
    },
  });
}

/** The Freesound tools of a host, none when it has no Freesound browser. */
export function freesoundTools(host: AgentHost): AgentTool[] {
  const free = host.freesound;
  return free ? [searchTool(free), importTool(host, free)] : [];
}
