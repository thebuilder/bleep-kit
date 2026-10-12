// The tool set: every tool bound to a host. This is the list a model sees, in the order it sees it.
import type { AgentHost } from "../host.ts";
import type { AgentTool } from "../tool-kit.ts";
import { changeSongChip } from "./chip.ts";
import { mutateSfxTool, newInstrument, newSfx, newSong } from "./create.ts";
import {
  chipInfo,
  deleteDocument,
  editDocument,
  listDocuments,
  readDocument,
  writeDocument,
} from "./documents.ts";
import { playTool, renderAnalyze, stopTool, viewAnalysis } from "./measure.ts";
import {
  listSamples,
  readSample,
  resampleTool,
  setInstrumentSample,
} from "./samples.ts";

export interface ToolOptions {
  /** False for a model that cannot look at images: `view_analysis` is left out. */
  images?: boolean;
}

export function createTools(
  host: AgentHost,
  opts: ToolOptions = {}
): AgentTool[] {
  return [
    listDocuments(host),
    readDocument(host),
    chipInfo(host),
    newSfx(host),
    mutateSfxTool(host),
    newInstrument(host),
    newSong(host),
    writeDocument(host),
    editDocument(host),
    changeSongChip(host),
    listSamples(host),
    resampleTool(host),
    readSample(host),
    setInstrumentSample(host),
    renderAnalyze(host),
    ...(opts.images === false ? [] : [viewAnalysis(host)]),
    playTool(host),
    stopTool(host),
    deleteDocument(host),
  ];
}
