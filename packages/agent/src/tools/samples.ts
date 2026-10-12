// The tools for user samples. A sample is a recording the person imported (megabytes of base64), so the model never
// sees or writes its audio: it lists and reads the metadata (name, rate, length, base note, loop) and points sample
// instruments at samples by id.
import {
  chipProfile,
  defaultInstrument,
  type Instrument,
} from "@bleepkit/core";
import {
  type AgentHost,
  type DocRef,
  isDocId,
  parseRef,
  type SampleInfo,
} from "../host.ts";
import { type AgentTool, defineTool, done, fail } from "../tool-kit.ts";
import { commit } from "./commit.ts";

const MAX_LISTED = 60;

function loopText(s: SampleInfo): string {
  return s.loop ? `loop ${s.loop.start}..${s.loop.end}` : "no loop";
}

function line(s: SampleInfo): string {
  return `${s.id}: "${s.name}", ${s.bits} bit mono ${s.rate} Hz, ${s.seconds} s (${s.frames} frames), base note ${s.baseNote}${s.finetune === 0 ? "" : ` ${s.finetune > 0 ? "+" : ""}${s.finetune} cents`}, volume ${s.volume}, ${loopText(s)}`;
}

/** The ids of the instruments that play a sample. */
function usersOf(
  instruments: Record<string, Instrument>,
  id: string
): string[] {
  return Object.entries(instruments)
    .filter(([, inst]) => inst.sample?.userSample === id)
    .map(([iid]) => iid)
    .sort();
}

export function listSamples(host: AgentHost): AgentTool {
  return defineTool<Record<string, never>>({
    description:
      "List the user samples (recordings the person imported): id, name, format, length, base note, loop and volume. The audio itself is never shown. Use set_instrument_sample to play one from an instrument.",
    inputSchema: { properties: {}, type: "object" },
    name: "list_samples",
    run: async () => {
      const samples = await host.samples();
      if (samples.length === 0) {
        return done(
          "No samples",
          "The project has no user samples. The person adds them in the studio (the Samples section: import a WAV, MP3 or OGG) or with `bleepkit import sample <file.wav>`. Generated samples (new_instrument with kind sample) need none."
        );
      }
      const shown = samples.slice(0, MAX_LISTED).map(line);
      const more = samples.length - MAX_LISTED;
      return done(
        `${samples.length} sample${samples.length === 1 ? "" : "s"}`,
        `${shown.join("\n")}${more > 0 ? `\n... and ${more} more` : ""}`
      );
    },
  });
}

export function readSample(host: AgentHost): AgentTool {
  return defineTool<{ id: string }>({
    description:
      "Read one user sample's metadata and which instruments play it. Never returns the audio.",
    inputSchema: {
      properties: { id: { description: "The sample id.", type: "string" } },
      required: ["id"],
      type: "object",
    },
    name: "read_sample",
    run: async ({ id }) => {
      const sample = (await host.samples()).find((s) => s.id === id);
      if (!sample) {
        return fail(
          `No sample ${id}`,
          `There is no sample "${id}". list_samples shows the ids.`
        );
      }
      const users = usersOf(await host.instruments(), id);
      return done(
        `sample/${id}`,
        `${line(sample)}\nUsed by: ${users.length > 0 ? users.map((u) => `instrument/${u}`).join(", ") : "no instrument yet"}.`
      );
    },
  });
}

export function setInstrumentSample(host: AgentHost): AgentTool {
  return defineTool<{ instrument: string; sample: string }>({
    description:
      "Make a sample instrument play a user sample. The instrument must be of kind sample (a new one is created with the project's chip when the id does not exist yet; chips that play samples are amiga, genesis (through the DAC, which the song turns on), snes and custom). Then use the instrument in a song like any other: the note you write is the pitch the sample sounds at, with the sample's base note as its natural pitch.",
    inputSchema: {
      properties: {
        instrument: {
          description: "The instrument id (lowercase letters, digits, dashes).",
          type: "string",
        },
        sample: { description: "The user sample id.", type: "string" },
      },
      required: ["instrument", "sample"],
      type: "object",
    },
    name: "set_instrument_sample",
    run: async ({ instrument, sample }) => {
      if (!isDocId(instrument)) {
        return fail(
          "Bad id",
          `"${instrument}" is not a valid instrument id: lowercase letters, digits and dashes.`
        );
      }
      const info = (await host.samples()).find((s) => s.id === sample);
      if (!info) {
        return fail(
          `No sample ${sample}`,
          `There is no sample "${sample}". list_samples shows the ids.`
        );
      }
      const ref = { id: instrument, kind: "instrument" as const };
      const existing = (await host.read(ref)) as Instrument | null;
      let next: Instrument;
      if (existing) {
        if (existing.kind !== "sample" || !existing.sample) {
          return fail(
            `instrument/${instrument} is not a sample instrument`,
            `instrument/${instrument} is a ${existing.kind} instrument. Only sample instruments can play a sample: pick another id for a new one, or make one with new_instrument (kind sample).`
          );
        }
        next = {
          ...existing,
          sample: { ...existing.sample, userSample: sample },
        };
      } else {
        const { chip } = await host.project();
        if (!chipProfile(chip).kinds.includes("sample")) {
          return fail(
            `${chip} cannot play samples`,
            `The project's chip ${chip} has no sample channels, so a sample instrument cannot be created for it. Samples play on amiga, genesis (DAC), snes and custom songs.`
          );
        }
        next = defaultInstrument("sample", chip);
        next.name = info.name.slice(0, 64);
        next.sample = {
          ...(next.sample ?? defaultInstrument("sample", chip).sample),
          userSample: sample,
        } as NonNullable<Instrument["sample"]>;
      }
      const { out } = await commit(host, ref, next);
      return out;
    },
  });
}

interface ResampleInput {
  bits?: number;
  id: string;
  name?: string;
  note?: number;
  rate?: number;
  ref: string;
}

function resampleProblem(
  input: ResampleInput,
  ref: DocRef | string
): string | null {
  if (typeof ref === "string") {
    return ref;
  }
  if (!isDocId(input.id)) {
    return `"${input.id}" is not a valid sample id: lowercase letters, digits and dashes.`;
  }
  if (input.bits !== undefined && input.bits !== 8 && input.bits !== 16) {
    return "bits must be 8 or 16";
  }
  if (
    input.rate !== undefined &&
    !(Number.isFinite(input.rate) && input.rate >= 1000 && input.rate <= 96_000)
  ) {
    return "rate must be between 1000 and 96000 Hz";
  }
  if (
    input.note !== undefined &&
    !(Number.isInteger(input.note) && input.note >= 0 && input.note <= 127)
  ) {
    return "note must be a MIDI note number from 0 to 127";
  }
  return null;
}

export function resampleTool(host: AgentHost): AgentTool {
  return defineTool<ResampleInput>({
    description:
      "Record a sound as a new user sample, the way a sampler of the 80s and 90s kept a sound: render an sfx, a song or one instrument note, mix it to mono, cut the silence and convert it for the project's chip (amiga and genesis store 8 bit). Then play it with set_instrument_sample. Use it to turn a generated drum or an FM sound into a sample instrument, or to crush a sound: bits 8 and a low rate (8000 to 11025) add the grit. The new id must not exist yet.",
    inputSchema: {
      properties: {
        bits: {
          description:
            "8 crushes to 8 bit. Default: what the project's chip stores.",
          enum: [8, 16],
          type: "integer",
        },
        id: {
          description:
            "The new sample's id (lowercase letters, digits, dashes).",
          type: "string",
        },
        name: { description: "A display name.", type: "string" },
        note: {
          description:
            "For an instrument ref: the MIDI note to play (default 60). It becomes the sample's base note.",
          type: "integer",
        },
        rate: {
          description: "Sample rate to store at, 1000 to 96000.",
          type: "number",
        },
        ref: {
          description:
            'What to record: "sfx/coin", "song/title" or "instrument/lead".',
          type: "string",
        },
      },
      required: ["ref", "id"],
      type: "object",
    },
    name: "resample",
    run: async (input) => {
      const ref = parseRef(input.ref);
      const problem = resampleProblem(input, ref);
      if (problem || typeof ref === "string") {
        return fail("Cannot resample", problem ?? String(ref));
      }
      if ((await host.samples()).some((s) => s.id === input.id)) {
        return fail(
          `sample/${input.id} exists`,
          `There is already a sample "${input.id}". Pick another id.`
        );
      }
      try {
        const info = await host.resample(ref, {
          id: input.id,
          ...(input.bits === undefined ? {} : { bits: input.bits as 8 | 16 }),
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.rate === undefined ? {} : { rate: input.rate }),
        });
        return done(
          `sample/${info.id}`,
          `Recorded ${input.ref} as ${line(info)}. set_instrument_sample makes an instrument play it.`
        );
      } catch (err) {
        return fail("Cannot resample", (err as Error).message);
      }
    },
  });
}
