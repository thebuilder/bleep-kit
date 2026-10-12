/* The studio side of the assistant's tools: an AgentHost over the real project (so an edit is a normal edit: live on
   screen, autosaved, undoable), the render worker, the analysis pictures and the engine. One assistant turn is one undo
   step per document: every write in a turn carries the same "group:" coalesce key, which the document history merges
   however far apart the writes are. A delete asks the person in the studio's own confirm dialog. */
import type {
  AgentHost,
  AgentImage,
  AnyDoc,
  DocKind,
  DocRef,
  DocSummary,
  ImageKind,
  Measured,
} from "@bleepkit/agent";
import { app } from "../app.ts";
import type { Instrument, Sfx } from "../lib/contract.ts";
import { hashString } from "../lib/core.ts";
import { playDoc, stopEverything } from "../playback.ts";
import { analyzeAsync, sourceOf } from "../render-service.ts";
import { type Doc, project } from "../state/docs.ts";
import { deleteDocument } from "../ui/delete-doc.ts";
import type { AnalysisBundle } from "../workers/render.ts";
import { pngBase64 } from "./png.ts";

export interface StudioHost extends AgentHost {
  /** Start a turn: its writes share one undo step per document. `signal` closes a delete question when it aborts. */
  beginTurn: (signal?: AbortSignal) => void;
  endTurn: () => void;
}

const WIDTH = 900;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function docOf(ref: DocRef): Doc | undefined {
  return project.get(ref.kind, ref.id);
}

function detailOf(d: Doc): string | null {
  if (d.kind === "sfx") {
    return (d.value as Sfx).category;
  }
  if (d.kind === "instrument") {
    return (d.value as Instrument).kind;
  }
  return null;
}

const nameOf = (d: Doc): string => (d.value as { name?: string }).name || d.id;

const KINDS: DocKind[] = ["sfx", "song", "instrument"];

let turns = 0;

export function createStudioHost(): StudioHost {
  let group = "";
  let signal: AbortSignal | undefined;
  /** The newest measurement, so asking for its pictures right after the numbers renders nothing twice. */
  let last: { bundle: AnalysisBundle; key: string } | null = null;

  async function measure(ref: DocRef, note?: number): Promise<AnalysisBundle> {
    const doc = docOf(ref);
    if (!doc) {
      throw new Error(`${ref.kind}/${ref.id} does not exist`);
    }
    const file = `${ref.kind}/${ref.id}`;
    const source = sourceOf(doc, note ?? 60);
    const key = `${file}:${project.project.master.volume}:${project.project.master.limiter}:${hashString(JSON.stringify(source))}`;
    if (last?.key === key) {
      return last.bundle;
    }
    const bundle = await analyzeAsync(source, file, WIDTH);
    last = { bundle, key };
    return bundle;
  }

  return {
    async analyze(ref, opts) {
      const bundle = await measure(ref, opts?.note);
      const imageKinds = (Object.keys(bundle.images) as ImageKind[]).filter(
        (k) => bundle.images[k] !== null
      );
      const out: Measured = { analysis: bundle.analysis, imageKinds };
      return out;
    },
    beginTurn(s) {
      turns += 1;
      group = `group:assistant-${turns}`;
      signal = s;
    },
    current() {
      const d = app.currentDoc();
      return d ? { id: d.id, kind: d.kind } : null;
    },
    endTurn() {
      group = "";
      signal = undefined;
    },
    async images(ref, kinds, opts) {
      const bundle = await measure(ref, opts?.note);
      const out: AgentImage[] = [];
      for (const kind of kinds) {
        const img = bundle.images[kind];
        if (img) {
          // biome-ignore lint/performance/noAwaitInLoops: at most three small pictures, one canvas at a time
          const data = await pngBase64(img);
          out.push({
            data,
            height: img.height,
            kind,
            mime: "image/png",
            width: img.width,
          });
        }
      }
      return out;
    },
    instruments() {
      return Promise.resolve(clone(project.instruments()));
    },
    list(kind) {
      const out: DocSummary[] = [];
      for (const k of kind ? [kind] : KINDS) {
        for (const d of project.list(k)) {
          out.push({
            detail: detailOf(d),
            id: d.id,
            kind: d.kind,
            name: nameOf(d),
          });
        }
      }
      return Promise.resolve(out);
    },
    play(ref) {
      const doc = docOf(ref);
      if (!doc) {
        return Promise.reject(
          new Error(`${ref.kind}/${ref.id} does not exist`)
        );
      }
      playDoc(doc);
      return Promise.resolve();
    },
    project() {
      const p = project.project;
      return Promise.resolve({
        chip: p.chip,
        master: { ...p.master },
        name: p.name,
        sampleRate: p.sampleRate,
        seed: p.seed,
      });
    },
    read(ref) {
      const doc = docOf(ref);
      return Promise.resolve(doc ? clone(doc.value) : null);
    },
    async remove(ref) {
      const doc = docOf(ref);
      if (!doc) {
        return { deleted: false, missing: true };
      }
      const wasOpen = app.currentDoc()?.path === doc.path;
      const deleted = await deleteDocument(doc, {
        navigate: false,
        ...(signal ? { signal } : {}),
      });
      if (deleted && wasOpen) {
        app.navigate("#/pads");
      }
      return { deleted, missing: false };
    },
    stop() {
      stopEverything();
      return Promise.resolve();
    },
    async write(ref, value) {
      const doc = docOf(ref);
      const next = clone(value) as AnyDoc;
      if (doc) {
        project.edit(doc, () => next, group);
        return { created: false };
      }
      await project.create(ref.kind, ref.id, next);
      return { created: true };
    },
  };
}
