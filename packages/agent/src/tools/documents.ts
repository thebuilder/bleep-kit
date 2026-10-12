// The tools that look at and change documents: list, read, write, edit and delete, plus the chip reference.
import {
  CHIP_IDS,
  type ChipId,
  chipProfile,
  chipSfxWaves,
} from "@bleepkit/core";
import { describeSfx } from "@bleepkit/sfx";
import { describeInstrument, describeSong } from "../describe.ts";
import {
  type AgentHost,
  type AnyDoc,
  DOC_KINDS,
  type DocKind,
  type DocRef,
  parseRef,
  refText,
} from "../host.ts";
import { applyChanges, type Change, getAt } from "../pointer.ts";
import {
  type AgentTool,
  defineTool,
  done,
  fail,
  parseJsonField,
  type ToolOutput,
} from "../tool-kit.ts";
import { commit } from "./commit.ts";

const MAX_LISTED = 80;
const MAX_JSON_CHARS = 9000;
const REF_HELP =
  'A document reference: "sfx/coin", "song/title" or "instrument/lead".';

/** The reference as a ref, or a failure the model can read. */
export function refOf(text: unknown) {
  const ref = parseRef(text);
  return typeof ref === "string"
    ? { error: fail("Bad reference", `${ref}.`) }
    : { ref };
}

/** One sentence about a document, from the same describers the CLI uses. */
export function describeDoc(ref: DocRef, doc: AnyDoc): string {
  if (ref.kind === "sfx") {
    return describeSfx(doc as Parameters<typeof describeSfx>[0]);
  }
  return ref.kind === "song"
    ? describeSong(doc as Parameters<typeof describeSong>[0])
    : describeInstrument(doc as Parameters<typeof describeInstrument>[0]);
}

export function listDocuments(host: AgentHost): AgentTool {
  return defineTool<{ kind?: DocKind }>({
    description:
      "List the project: its settings (name, chip, sample rate, master) and every sound effect, song and instrument with its id and a few facts. Call this first to see what exists and which ids are taken.",
    inputSchema: {
      properties: {
        kind: {
          description: "Only this kind.",
          enum: DOC_KINDS,
          type: "string",
        },
      },
      type: "object",
    },
    name: "list_documents",
    run: async ({ kind }) => {
      const [project, docs] = await Promise.all([
        host.project(),
        host.list(kind),
      ]);
      const lines = docs
        .slice(0, MAX_LISTED)
        .map(
          (d) =>
            `${refText(d)}  "${d.name}"${d.detail ? `  (${d.detail})` : ""}`
        );
      const more = docs.length - MAX_LISTED;
      return done(
        `Listed ${docs.length} document${docs.length === 1 ? "" : "s"}`,
        [
          `Project "${project.name}": chip ${project.chip}, ${project.sampleRate} Hz, seed ${project.seed}, master volume ${project.master.volume}${project.master.limiter ? " with limiter" : ""}.`,
          docs.length === 0
            ? `No ${kind ?? "document"}s yet.`
            : lines.join("\n"),
          more > 0 ? `... and ${more} more` : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
    },
  });
}

export function readDocument(host: AgentHost): AgentTool {
  return defineTool<{ path?: string; ref: string }>({
    description:
      "Read a document: a plain-words description first, then its JSON (long ones are cut; pass `path`, a JSON pointer such as /channels/2/mml or /patterns, to read just that part). Read before you change something you did not write in this conversation.",
    inputSchema: {
      properties: {
        path: {
          description:
            "JSON pointer to a part of the document, such as /channels/0 or /envelope.",
          type: "string",
        },
        ref: { description: REF_HELP, type: "string" },
      },
      required: ["ref"],
      type: "object",
    },
    name: "read_document",
    run: async (input) => {
      const parsed = refOf(input.ref);
      if (parsed.error) {
        return parsed.error;
      }
      const doc = await host.read(parsed.ref);
      const name = refText(parsed.ref);
      if (!doc) {
        return fail(
          `No ${name}`,
          `There is no ${name}. Call list_documents to see what exists.`
        );
      }
      let part: unknown = doc;
      if (input.path) {
        const at = getAt(doc, input.path);
        if (!at.ok) {
          return fail(`${name}: bad path`, `${at.error}.`);
        }
        part = at.value;
      }
      const json = JSON.stringify(part, null, input.path ? 1 : 0);
      const body =
        json.length > MAX_JSON_CHARS
          ? `${json.slice(0, MAX_JSON_CHARS)}\n... cut at ${MAX_JSON_CHARS} of ${json.length} characters: read parts with \`path\` (for example /patterns or /channels/0).`
          : json;
      return done(
        `Read ${name}${input.path ? ` ${input.path}` : ""}`,
        `${describeDoc(parsed.ref, doc)}\n\nJSON${input.path ? ` at ${input.path}` : ""}:\n${body}`
      );
    },
  });
}

export function writeDocument(host: AgentHost): AgentTool {
  return defineTool<{ json: unknown; ref: string }>({
    coerce: (input) => parseJsonField(input, "json"),
    description:
      "Create or replace a whole document from JSON. It is normalized first: a document with errors is refused and nothing is saved, and the problems come back so you can fix them. Values out of range are clamped and listed. For small changes to an existing document prefer edit_document. The format is in the system prompt.",
    inputSchema: {
      properties: {
        json: {
          description: "The complete document as a JSON object.",
          type: "object",
        },
        ref: { description: REF_HELP, type: "string" },
      },
      required: ["ref", "json"],
      type: "object",
    },
    name: "write_document",
    run: async (input) => {
      const parsed = refOf(input.ref);
      if (parsed.error) {
        return parsed.error;
      }
      return (await commit(host, parsed.ref, input.json)).out;
    },
  });
}

interface RawChange {
  op?: "set" | "remove";
  path: string;
  value?: unknown;
}

function chipOf(doc: unknown): unknown {
  return (doc as { chip?: unknown } | null)?.chip;
}

/** Edits that would change a song's chip are refused: change_song_chip moves the music instead of dropping it. */
function chipEditRefusal(
  kind: string,
  name: string,
  before: unknown,
  after: unknown
): ToolOutput | null {
  return kind === "song" && chipOf(after) !== chipOf(before)
    ? fail(
        `${name}: use change_song_chip`,
        `Changing a song's chip here would drop every channel the new chip does not share. Use change_song_chip with ref "${name}": it moves the lead, bass, drums and harmony to the channels that suit the new chip. Nothing was changed.`
      )
    : null;
}

/** The raw changes as pointer edits, or the refusal for the first one that has no value. */
function toChanges(
  name: string,
  raw: readonly RawChange[]
): { changes: Change[] } | { error: ToolOutput } {
  const changes: Change[] = [];
  for (const [n, c] of raw.entries()) {
    if (c.op !== "remove" && c.value === undefined) {
      return {
        error: fail(
          `${name}: bad change`,
          `change ${n + 1} (${c.path}) has no "value". Give a value, or use "op": "remove".`
        ),
      };
    }
    changes.push(
      c.op === "remove"
        ? { op: "remove", path: c.path }
        : { op: "set", path: c.path, value: c.value }
    );
  }
  return { changes };
}

export function editDocument(host: AgentHost): AgentTool {
  return defineTool<{ changes: RawChange[]; ref: string }>({
    coerce: (input) => parseJsonField(input, "changes"),
    description:
      'Change parts of an existing document with JSON-pointer edits, applied in order: {"path": "/channels/2/mml", "value": "o2 l8 ..."} sets a value (default op), {"op": "remove", "path": "/channels/3"} removes a key or array item, and "-" as the last array index appends. The result is normalized as a whole and refused, with the problems listed, if it would be invalid. Cheaper and safer than rewriting a long document.',
    inputSchema: {
      properties: {
        changes: {
          items: {
            properties: {
              op: { enum: ["set", "remove"], type: "string" },
              path: {
                description:
                  "JSON pointer, such as /envelope/decay or /channels/1/volume.",
                type: "string",
              },
              value: {
                description: "The new value (any JSON). Not used by remove.",
              },
            },
            required: ["path"],
            type: "object",
          },
          maxItems: 40,
          minItems: 1,
          type: "array",
        },
        ref: { description: REF_HELP, type: "string" },
      },
      required: ["ref", "changes"],
      type: "object",
    },
    name: "edit_document",
    run: async (input) => {
      const parsed = refOf(input.ref);
      if (parsed.error) {
        return parsed.error;
      }
      const name = refText(parsed.ref);
      const doc = await host.read(parsed.ref);
      if (!doc) {
        return fail(
          `No ${name}`,
          `There is no ${name} to edit. Create it with write_document or a new_* tool.`
        );
      }
      const built = toChanges(name, input.changes);
      if ("error" in built) {
        return built.error;
      }
      const { changes } = built;
      const applied = applyChanges(doc, changes);
      if (!applied.ok) {
        return fail(
          `${name}: edit failed`,
          `${applied.error}. Nothing was changed.`
        );
      }
      const refusal = chipEditRefusal(
        parsed.ref.kind,
        name,
        doc,
        applied.value
      );
      if (refusal) {
        return refusal;
      }
      const { out } = await commit(host, parsed.ref, applied.value, {
        verb: "Edited",
      });
      return out.isError
        ? out
        : {
            ...out,
            summary: `Edited ${name} (${changes.length} change${changes.length === 1 ? "" : "s"})`,
          };
    },
  });
}

export function deleteDocument(host: AgentHost): AgentTool {
  return defineTool<{ ref: string }>({
    description:
      "Delete a document from the project. The person is asked to confirm in a dialog and may say no. Only do it when they asked for it or it is clearly part of what they asked, and always say in your reply that you deleted (or tried to delete) it.",
    inputSchema: {
      properties: { ref: { description: REF_HELP, type: "string" } },
      required: ["ref"],
      type: "object",
    },
    name: "delete_document",
    run: async (input) => {
      const parsed = refOf(input.ref);
      if (parsed.error) {
        return parsed.error;
      }
      const name = refText(parsed.ref);
      const res = await host.remove(parsed.ref);
      if (res.missing) {
        return fail(`No ${name}`, `There is no ${name}, nothing to delete.`);
      }
      return res.deleted
        ? done(
            `Deleted ${name}`,
            `Deleted ${name}. Tell the person that you deleted it.`
          )
        : done(
            `Delete of ${name} declined`,
            `The person declined, ${name} is still in the project. Do not ask again unless they do.`
          );
    },
  });
}

export function chipInfo(host: AgentHost): AgentTool {
  return defineTool<{ chip?: ChipId }>({
    description:
      "The channel ids, instrument kinds, sound effect waves and hardware limits of a chip. Look it up before writing a song for a chip (channel ids differ per chip) or when something is refused as unavailable on the chip.",
    inputSchema: {
      properties: {
        chip: {
          description: "Default: the project's chip.",
          enum: CHIP_IDS,
          type: "string",
        },
      },
      type: "object",
    },
    name: "chip_info",
    run: async ({ chip }) => {
      const id = chip ?? (await host.project()).chip;
      const p = chipProfile(id);
      const c = p.constraints;
      const channels = p.channels.map(
        (ch) =>
          `${ch.id} (${ch.kind}${ch.fmOps ? `, ${ch.fmOps} operators` : ""}${ch.fixedDuty ? `, fixed duty ${ch.fixedDuty}` : ""})`
      );
      return done(
        `Looked up the ${id} chip`,
        [
          `${p.label} (${id}).`,
          id === "custom"
            ? "Channels: custom declares its own in the song (any kind)."
            : `Channels: ${channels.join(", ")}.`,
          `Instrument kinds it can host: ${p.kinds.join(", ")}.`,
          id === "genesis"
            ? 'DAC: set "master": { "genesis": { "dac": true } } in the song and channel fm6 becomes a sample channel (kind "sample", 8 bit mono, 8 to 26 kHz): it plays sample instruments for drums or bass hits instead of FM.'
            : "",
          `Sound effect waves: ${chipSfxWaves(id).join(", ")}.`,
          `Pitch: ${c.pitch === "period" ? `snaps to period registers (clock ${c.clockHz} Hz)` : "exact"}. Volume steps: ${c.volumeSteps || "continuous"}. Pan: ${c.pan}. Noise: ${c.noise}.`,
          c.dutyCycles.length > 0
            ? `Pulse duty cycles: ${c.dutyCycles.join(", ")}.`
            : "",
          c.waveTable
            ? `Wavetable: ${c.waveTable.length} entries of ${c.waveTable.bits} bits.`
            : "",
          `Filter: ${c.filter ? "yes" : "no"}. Echo and reverb: ${c.masterFx ? "yes" : "no"}.`,
        ]
          .filter(Boolean)
          .join("\n")
      );
    },
  });
}
