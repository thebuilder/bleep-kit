/* "Use": a Freesound sound becomes a sample document that remembers where it came from. The audio is the HQ preview
   (Freesound's original files need a login, the preview does not), made mono and level; from there it is imported like
   any other recording (resampled and quantized for the project's chip, base note set, loop off). The base note comes
   from Freesound's `note_name` descriptor when it has one. */

import { app } from "../app.ts";
import type { SampleSource, UserSample } from "../lib/contract.ts";
import { parseNoteName } from "../lib/core.ts";
import { project } from "../state/docs.ts";
import {
  createSampleInstrument,
  importDecodedAudio,
} from "../ui/import-audio.ts";
import type { FreesoundSound } from "./api.ts";
import type { PreviewPlayer } from "./preview.ts";

export type UseMode = "sample" | "instrument";

/** The attribution stored in the sample document. */
function sourceOf(sound: FreesoundSound): SampleSource {
  return {
    author: sound.author,
    id: sound.id,
    kind: "freesound",
    license: sound.license === "cc0" ? "CC0" : "CC BY",
    name: sound.name,
    url: sound.url,
  };
}

export interface Used {
  instrumentId: string | null;
  sampleId: string;
}

/**
 * Import `sound` as a sample, and with mode "instrument" also a sample instrument that plays it on the project's chip.
 * Opens the sample editor (or the instrument editor) unless `open` is false. Resolves to null when the import failed
 * (a toast says why).
 */
export async function useSound(
  sound: FreesoundSound,
  player: Pick<PreviewPlayer, "load">,
  mode: UseMode,
  opts: { instrumentId?: string; open?: boolean } = {}
): Promise<Used | null> {
  const open = opts.open ?? true;
  const loaded = await player.load(sound);
  const sampleId = await importDecodedAudio(
    { channels: [loaded.mono], sampleRate: loaded.rate },
    sound.name.slice(0, 64),
    sound.name,
    {
      baseNote: sound.note ? parseNoteName(sound.note) : null,
      open: open && mode === "sample",
      source: sourceOf(sound),
    }
  );
  if (sampleId === null) {
    return null;
  }
  if (mode === "sample") {
    return { instrumentId: null, sampleId };
  }
  const doc = project.get("sample", sampleId);
  if (!doc) {
    return { instrumentId: null, sampleId };
  }
  const inst = await createSampleInstrument(
    sampleId,
    doc.value as UserSample,
    opts.instrumentId
  );
  app.toast(`Made instrument ${inst.id} for ${sampleId}`);
  if (open) {
    app.navigate(`#/instrument/${encodeURIComponent(inst.id)}`);
  }
  return { instrumentId: inst.id, sampleId };
}
