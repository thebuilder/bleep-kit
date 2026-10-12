// An in-memory AgentHost for the tool tests: documents in a map, a canned analysis, and a record of what the tools did.
import {
  defaultProject,
  type Instrument,
  makeInstrument,
  normalizeSfx,
  normalizeSong,
} from "@bleepkit/core";
import type { Analysis } from "@bleepkit/core/tools";
import { generateSfx } from "@bleepkit/sfx";
import type {
  AgentHost,
  AnyDoc,
  DocKind,
  DocRef,
  ImageKind,
  ProjectSummary,
} from "../src/index.ts";

const key = (ref: DocRef): string => `${ref.kind}/${ref.id}`;

export function analysisOf(over: Partial<Analysis> = {}): Analysis {
  return {
    channels: 1,
    clipped: { first: null, frames: 0 },
    crestDb: 9,
    dcOffset: 0,
    duration: 0.32,
    dutyCycle: 0.5,
    envelope: Array.from({ length: 32 }, (_, i) => ({
      db: -10 - i,
      time: i * 0.01,
    })),
    file: "x",
    frames: 14_112,
    leadingSilence: 0,
    loop: null,
    lufs: -18.4,
    peakDb: -9.1,
    pitch: {
      medianHz: 1046.5,
      medianNote: "C-6",
      track: [
        { confidence: 0.9, hz: 523.25, time: 0 },
        { confidence: 0.9, hz: 1046.5, time: 0.2 },
      ],
    },
    rmsDb: -17.8,
    sampleRate: 44_100,
    silenceDb: -80,
    spectrum: {
      bands: { highDb: -30, lowDb: -48, midDb: -14 },
      centroidHz: 1520,
    },
    trailingSilence: 0,
    ...over,
  };
}

export interface FakeHost extends AgentHost {
  analysis: Analysis;
  calls: string[];
  confirmDelete: boolean;
  docs: Map<string, AnyDoc>;
  open: DocRef | null;
}

function fakeHost(): FakeHost {
  const docs = new Map<string, AnyDoc>();
  const project = defaultProject("Test");
  const host: FakeHost = {
    analysis: analysisOf(),
    analyze: (ref) => {
      host.calls.push(`analyze ${key(ref)}`);
      return Promise.resolve({
        analysis: host.analysis,
        imageKinds:
          ref.kind === "song"
            ? ["waveform", "spectrogram", "scopes"]
            : ["waveform", "spectrogram"],
      });
    },
    calls: [],
    confirmDelete: true,
    current: () => host.open,
    docs,
    images: (ref, kinds: readonly ImageKind[]) => {
      host.calls.push(`images ${key(ref)} ${kinds.join(",")}`);
      return Promise.resolve(
        kinds
          .filter((k) => k !== "scopes" || ref.kind === "song")
          .map((kind) => ({
            data: "iVBORw0KGgo=",
            height: 4,
            kind,
            mime: "image/png" as const,
            width: 8,
          }))
      );
    },
    instruments: () => {
      const out: Record<string, Instrument> = {};
      for (const [k, v] of docs) {
        if (k.startsWith("instrument/")) {
          out[k.slice("instrument/".length)] = v as Instrument;
        }
      }
      return Promise.resolve(out);
    },
    list: (kind?: DocKind) =>
      Promise.resolve(
        [...docs.entries()]
          .filter(([k]) => !kind || k.startsWith(`${kind}/`))
          .map(([k, v]) => {
            const [kd = "sfx", id = ""] = k.split("/");
            const doc = v as { category?: string; kind?: string; name: string };
            return {
              detail: (kd === "sfx" ? doc.category : doc.kind) ?? null,
              id,
              kind: kd as DocKind,
              name: doc.name,
            };
          })
      ),
    open: null,
    play: (ref) => {
      host.calls.push(`play ${key(ref)}`);
      return Promise.resolve();
    },
    project: () =>
      Promise.resolve<ProjectSummary>({
        chip: "nes",
        master: project.master,
        name: project.name,
        sampleRate: project.sampleRate,
        seed: project.seed,
      }),
    read: (ref) => Promise.resolve(docs.get(key(ref)) ?? null),
    remove: (ref) => {
      host.calls.push(`remove ${key(ref)}`);
      if (!docs.has(key(ref))) {
        return Promise.resolve({ deleted: false, missing: true });
      }
      if (host.confirmDelete) {
        docs.delete(key(ref));
      }
      return Promise.resolve({ deleted: host.confirmDelete, missing: false });
    },
    stop: () => {
      host.calls.push("stop");
      return Promise.resolve();
    },
    write: (ref, value) => {
      const created = !docs.has(key(ref));
      docs.set(key(ref), value);
      host.calls.push(`write ${key(ref)}`);
      return Promise.resolve({ created });
    },
  };
  return host;
}

/** A host with an NES project: a lead, a bass and drums, one coin sound and one tiny song. */
export function seededHost(): FakeHost {
  const host = fakeHost();
  host.docs.set(
    "instrument/lead",
    makeInstrument("pulse", "nes", "lead", "Lead")
  );
  host.docs.set(
    "instrument/bass",
    makeInstrument("triangle", "nes", "bass", "Bass")
  );
  host.docs.set(
    "instrument/drums",
    makeInstrument("noise", "nes", "drums", "Drums")
  );
  host.docs.set(
    "sfx/coin",
    normalizeSfx(generateSfx("coin", { chip: "nes", name: "Coin", seed: 1 }))
      .value
  );
  return host;
}

export function seedSong(host: FakeHost): void {
  const song = normalizeSong(
    {
      channels: [
        {
          id: "pulse1",
          instrument: "lead",
          kind: "pulse",
          mml: "t140 o4 l8 cdefgab>c L",
        },
        {
          id: "triangle",
          instrument: "bass",
          kind: "triangle",
          mml: "o2 l4 c g c g",
        },
      ],
      chip: "nes",
      name: "Tune",
      order: [],
      patterns: {},
      tempo: 140,
      version: 1,
    },
    {}
  );
  host.docs.set("song/tune", song.value);
}
