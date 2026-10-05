import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  type Analysis,
  analyze,
  decodeWav,
  encodePng,
  spectrogramImage,
  waveformImage,
} from "@bleepkit/core/tools";
import { analysisText } from "../analysis-text.ts";
import { CliError, display } from "../output.ts";
import { openProject, resolveRef, writeFileAtomic } from "../project.ts";
import { type RenderOpts, renderDoc } from "../render.ts";
import type { CommandSpec } from "./types.ts";

const WAV_EXT_RE = /\.wav$/i;

const AUDIO_EXT = /\.(wav|ogg|mp3)$/i;

function analyzeFile(
  ctx: Parameters<CommandSpec["run"]>[0],
  file: string,
  images: boolean,
  window: number | undefined
): Analysis {
  const abs = path.resolve(ctx.cwd, file);
  if (!fs.existsSync(abs)) {
    throw new CliError("not-found", `file not found: ${file}`, {
      hint: "Pass a .wav path, or a document ref such as sfx/coin.",
    });
  }
  if (!abs.toLowerCase().endsWith(".wav")) {
    throw new CliError(
      "invalid",
      `cannot decode ${path.extname(abs)} files: only .wav can be analyzed from a path`,
      {
        hint: "Analyze the document instead (bleepkit analyze sfx/coin), or its master: out/sfx/coin.wav.",
      }
    );
  }
  let result: ReturnType<typeof decodeWav>;
  try {
    result = decodeWav(new Uint8Array(fs.readFileSync(abs)));
  } catch (error) {
    throw CliError.because(
      error,
      "invalid",
      `cannot read ${file} as WAV: ${(error as Error).message}`
    );
  }
  // a bare file does not say what made it, so no duty cycle is reported
  const analysis = analyze(result, {
    file: display(ctx.cwd, abs),
    ...(window ? { pitchWindow: window } : {}),
    wave: null,
  });
  analysis.file = display(ctx.cwd, abs);
  if (images) {
    const deflate = (d: Uint8Array) => new Uint8Array(zlib.deflateSync(d));
    const base = abs.replace(WAV_EXT_RE, "");
    const wave = `${base}.waveform.png`;
    const spec = `${base}.spectrogram.png`;
    writeFileAtomic(wave, encodePng(waveformImage(result), deflate));
    writeFileAtomic(spec, encodePng(spectrogramImage(result), deflate));
    analysis.images = {
      spectrogram: display(ctx.cwd, spec),
      waveform: display(ctx.cwd, wave),
    };
  }
  return analysis;
}

export const analyzeCommand: CommandSpec = {
  description:
    "Measures a render so you can judge it without listening: duration, peak, RMS, LUFS, clipping, silence at the " +
    "ends, spectrum balance, median pitch and note, loop seam quality, an envelope. For a document ref the render in " +
    "out/ is used when its hash is current, and re-rendered first when stale or missing. A path to a .wav works too " +
    "(ogg and mp3 cannot be decoded here; analyze the ref instead). --images writes waveform and spectrogram PNGs " +
    "(and scopes for songs); --pitch keeps the full pitch track instead of 200 entries.",
  examples: [
    "bleepkit analyze sfx/coin",
    "bleepkit analyze song/title --images --pitch --json",
    "bleepkit analyze out/sfx/coin.wav",
  ],
  flags: [
    {
      description: "write PNGs: waveform, spectrogram (scopes for songs)",
      name: "images",
      type: "boolean",
    },
    {
      description:
        "include the whole pitch track (default: at most 200 entries)",
      name: "pitch",
      type: "boolean",
    },
    {
      default: "2048",
      description: "pitch tracker window in frames",
      name: "window",
      type: "number",
      valueName: "<frames>",
    },
    {
      description: "exit 1 when the audio clips",
      name: "strict",
      type: "boolean",
    },
  ],
  name: "analyze",
  noProject: true,
  run: async (ctx, args) => {
    const [target] = args.positionals;
    if (!target) {
      throw new CliError(
        "usage",
        "analyze needs a document ref or a .wav path",
        {
          hint: "Example: bleepkit analyze sfx/coin   or   bleepkit analyze out/sfx/coin.wav",
        }
      );
    }
    const images = args.bool("images") ?? false;
    const window = args.num("window");
    const looksLikeFile =
      AUDIO_EXT.test(target) ||
      (target.includes(path.sep) &&
        fs.existsSync(path.resolve(ctx.cwd, target)) &&
        fs.statSync(path.resolve(ctx.cwd, target)).isFile());
    let analysis: Analysis;
    let cached: boolean | undefined;
    let ref: string | undefined;
    if (looksLikeFile) {
      analysis = analyzeFile(ctx, target, images, window);
    } else {
      const pc = openProject(ctx);
      const r = resolveRef(pc, target, ["sfx", "song", "instrument"]);
      if (r.kind === "instrument") {
        throw new CliError("usage", `${r.ref} has no render of its own`, {
          hint: "Analyze a song or sfx that uses it.",
        });
      }
      const opts: RenderOpts = {
        analyze: true,
        images,
        pitch: args.bool("pitch") ?? false,
      };
      if (window !== undefined) {
        opts.window = window;
      }
      const entry = await renderDoc(pc, r.kind, r.id, opts, {
        log: (t) => ctx.progress(t),
      });
      if (!entry.analysis) {
        throw new CliError("invalid", `no analysis produced for ${r.ref}`);
      }
      ({ analysis, cached } = entry);
      ({ ref } = r);
    }
    const clipped = analysis.clipped.frames > 0;
    const strictFail = (args.bool("strict") ?? false) && clipped;
    return {
      exit: strictFail ? 1 : 0,
      human: analysisText(
        analysis,
        ref ? `${ref} (${analysis.file})` : undefined
      ),
      json: {
        ...analysis,
        ...(cached === undefined ? {} : { cached }),
        ok: true,
        ...(ref ? { ref } : {}),
      },
    };
  },
  summary: "measure a render: peak, loudness, pitch, loop seam, envelope",
  usage: "analyze <ref|file.wav> [--images] [--pitch] [--window 2048]",
};
