// The tools that close the loop for an agent that cannot hear: render and measure, look at the pictures of the
// measurement, and make the studio play or stop.

import { analysisText } from "../analysis-text.ts";
import { type AgentHost, type ImageKind, refText } from "../host.ts";
import { type AgentTool, defineTool, done, fail } from "../tool-kit.ts";
import type { ImageBlock } from "../types.ts";
import { refOf } from "./documents.ts";

const REF = {
  description:
    'What to measure: "sfx/coin", "song/title" or "instrument/lead".',
  type: "string",
} as const;
const NOTE = {
  description: "Instruments only: the MIDI note to play (default 60 = C-4).",
  maximum: 119,
  minimum: 12,
  type: "integer",
} as const;

const IMAGE_KINDS: readonly ImageKind[] = ["waveform", "spectrogram", "scopes"];
const LEGEND: Record<ImageKind, string> = {
  scopes:
    "scopes: one oscilloscope trace per channel (shows which channel makes what)",
  spectrogram:
    "spectrogram: time left to right, frequency bottom (low) to top (high), brighter is louder",
  waveform:
    "waveform: time left to right, amplitude up and down; flat tops mean clipping",
};

export function renderAnalyze(host: AgentHost): AgentTool {
  return defineTool<{ note?: number; ref: string }>({
    description:
      "Render a document with the real engine and measure it: duration, peak, RMS and LUFS loudness, clipping, silence, spectrum, pitch, loop seam and a coarse envelope, with checks against the targets (songs about -14 to -16 LUFS, sfx peaks between -6 and -16 dBFS, no clipping, loop seam below -40 dB). You cannot hear, so call this after every change that matters.",
    inputSchema: {
      properties: { note: NOTE, ref: REF },
      required: ["ref"],
      type: "object",
    },
    name: "render_analyze",
    run: async (input) => {
      const parsed = refOf(input.ref);
      if (parsed.error) {
        return parsed.error;
      }
      const name = refText(parsed.ref);
      if (!(await host.read(parsed.ref))) {
        return fail(
          `No ${name}`,
          `There is no ${name}. Call list_documents to see what exists.`
        );
      }
      const { analysis } = await host.analyze(
        parsed.ref,
        input.note === undefined ? {} : { note: input.note }
      );
      const { summary, text } = analysisText(name, parsed.ref.kind, analysis);
      return done(summary, text);
    },
  });
}

export function viewAnalysis(host: AgentHost): AgentTool {
  return defineTool<{ images?: ImageKind[]; note?: number; ref: string }>({
    description:
      "Look at pictures of a render: the waveform, the spectrogram and, for songs, the per-channel oscilloscopes. Use it to see what the numbers cannot say (a click, a thin or muddy spectrum, a channel that is silent). Costs image tokens, so ask for what you need.",
    inputSchema: {
      properties: {
        images: {
          description: "Which pictures. Default: waveform and spectrogram.",
          items: { enum: IMAGE_KINDS, type: "string" },
          maxItems: 3,
          minItems: 1,
          type: "array",
        },
        note: NOTE,
        ref: REF,
      },
      required: ["ref"],
      type: "object",
    },
    name: "view_analysis",
    run: async (input) => {
      const parsed = refOf(input.ref);
      if (parsed.error) {
        return parsed.error;
      }
      const name = refText(parsed.ref);
      if (!(await host.read(parsed.ref))) {
        return fail(
          `No ${name}`,
          `There is no ${name}. Call list_documents to see what exists.`
        );
      }
      const wanted = input.images ?? ["waveform", "spectrogram"];
      const shots = await host.images(
        parsed.ref,
        wanted,
        input.note === undefined ? {} : { note: input.note }
      );
      if (shots.length === 0) {
        return fail(
          `No pictures of ${name}`,
          `No pictures could be made of ${name} (scopes exist only for songs).`
        );
      }
      const images: ImageBlock[] = shots.map((s) => ({
        data: s.data,
        height: s.height,
        label: `${s.kind} of ${name}`,
        mime: s.mime,
        type: "image",
        width: s.width,
      }));
      const kinds = shots.map((s) => s.kind);
      return {
        images,
        summary: `Looked at the ${kinds.join(" and ")} of ${name}`,
        text: `${kinds.length} picture${kinds.length === 1 ? "" : "s"} of ${name}, in this order:\n${kinds.map((k) => `- ${LEGEND[k]}`).join("\n")}`,
      };
    },
  });
}

export function playTool(host: AgentHost): AgentTool {
  return defineTool<{ ref: string }>({
    description:
      "Play a document in the studio so the person can hear it. You cannot hear it yourself: this is for them. Songs play until stopped; tell them what to listen for.",
    inputSchema: {
      properties: { ref: REF },
      required: ["ref"],
      type: "object",
    },
    name: "play",
    run: async (input) => {
      const parsed = refOf(input.ref);
      if (parsed.error) {
        return parsed.error;
      }
      const name = refText(parsed.ref);
      if (!(await host.read(parsed.ref))) {
        return fail(
          `No ${name}`,
          `There is no ${name}. Call list_documents to see what exists.`
        );
      }
      await host.play(parsed.ref);
      return done(
        `Playing ${name}`,
        `Started ${name} in the studio. The person hears it now; you do not.`
      );
    },
  });
}

export function stopTool(host: AgentHost): AgentTool {
  return defineTool<Record<string, never>>({
    description: "Stop whatever the studio is playing.",
    inputSchema: { properties: {}, type: "object" },
    name: "stop",
    run: async () => {
      await host.stop();
      return done("Stopped playback", "Stopped.");
    },
  });
}
