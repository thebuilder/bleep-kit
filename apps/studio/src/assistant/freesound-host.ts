/* The assistant's Freesound tools over the studio's own Freesound browser: a search goes through the same /api/freesound
   routes as the panel (so the same whitelist, the same CC0 and CC BY rule, the same caching), and an import is the
   panel's "Use". Only a sound a search returned in this session can be imported, so the model cannot reach a sound
   whose license nobody has looked at. */
import type { FreesoundHit, FreesoundHost, SampleInfo } from "@bleepkit/agent";
import {
  DEFAULT_QUERY,
  type FreesoundQuery,
  MAX_LENGTHS,
  MAX_QUERY,
} from "../../server/freesound/protocol.ts";
import {
  type FreesoundSound,
  fetchPreviewBytes,
  searchSounds,
} from "../freesound/api.ts";
import { useSound } from "../freesound/import.ts";
import { PreviewPlayer } from "../freesound/preview.ts";
import { decodeAudioBytes } from "../lib/audio-decode.ts";
import type { UserSample } from "../lib/contract.ts";
import { project } from "../state/docs.ts";

const round1 = (n: number): number => Math.round(n * 10) / 10;

function hitOf(sound: FreesoundSound): FreesoundHit {
  return {
    author: sound.author,
    id: sound.id,
    license: sound.license === "cc0" ? "CC0" : "CC BY",
    name: sound.name,
    note: sound.note,
    oneShot: sound.oneShot === true,
    seconds: round1(sound.duration),
    subcategory: sound.subcategory,
    tags: sound.tags,
  };
}

/** Importing needs the decoded preview only; nothing is played. */
const importer = new PreviewPlayer({
  decode: decodeAudioBytes,
  fetchBytes: fetchPreviewBytes,
  play: () => undefined,
  stop: () => undefined,
});

export function createFreesoundHost(
  infoOf: (id: string, sample: UserSample) => SampleInfo
): FreesoundHost {
  /** The sounds the model has been shown, by id. */
  const shown = new Map<number, FreesoundSound>();
  return {
    async import(id, opts) {
      const sound = shown.get(id);
      if (!sound) {
        throw new Error(
          `Freesound sound ${id} was not in a search result of this session. Run search_freesound and import one of its ids.`
        );
      }
      const used = await useSound(
        sound,
        importer,
        opts.instrument === null ? "sample" : "instrument",
        {
          open: false,
          ...(opts.instrument === null
            ? {}
            : { instrumentId: opts.instrument }),
        }
      );
      const sample = used ? project.samples()[used.sampleId] : undefined;
      if (!(used && sample)) {
        throw new Error(
          `Could not import "${sound.name}" (the studio says why in its notice).`
        );
      }
      return {
        hit: hitOf(sound),
        instrument: used.instrumentId,
        sample: infoOf(used.sampleId, sample),
      };
    },
    async search(opts) {
      const query: FreesoundQuery = {
        ...DEFAULT_QUERY,
        license: opts.license ?? "cc0",
        // the route takes the lengths the panel offers: the shortest one that is not shorter than asked
        maxSeconds:
          opts.maxSeconds === undefined
            ? null
            : (MAX_LENGTHS.find((m) => m >= (opts.maxSeconds ?? 0)) ?? null),
        oneShot: opts.oneShot ?? false,
        page: opts.page ?? 1,
        q: (opts.query ?? "").slice(0, MAX_QUERY),
        sort: opts.sort ?? "relevance",
        sub: opts.subcategory ?? null,
        tags: (opts.tags ?? []).map((t) => t.toLowerCase()).slice(0, 4),
      };
      const out = await searchSounds(query);
      for (const sound of out.results) {
        shown.set(sound.id, sound);
      }
      return {
        count: out.count,
        hasMore: out.hasMore,
        hits: out.results.map(hitOf),
        notes: out.notes,
      };
    },
  };
}
