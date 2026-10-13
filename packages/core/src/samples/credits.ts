/* CREDITS.txt: the attribution a game must show for the Creative Commons Attribution (CC BY) samples it ships. CC0
   samples need none. Pure text: the CLI's export and the studio's zips both write the result as a file. */
import type { SampleSource, UserSample } from "../types.ts";

export const CREDITS_FILE = "CREDITS.txt";

/** First line of the file, so a tool can tell its own CREDITS.txt from one a person wrote. */
export const CREDITS_HEADER = "Sound credits";

/** The CC BY sources among `samples` (by sample id), one per Freesound sound, in a stable order. */
export function creditedSources(
  samples: Record<string, Pick<UserSample, "source">>
): SampleSource[] {
  const seen = new Map<number, SampleSource>();
  for (const sample of Object.values(samples)) {
    const s = sample.source;
    if (s && s.license === "CC BY" && !seen.has(s.id)) {
      seen.set(s.id, s);
    }
  }
  return [...seen.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id - b.id
  );
}

/**
 * The text of CREDITS.txt for these samples, or null when none of them needs a credit (so no file is written).
 * The line has what CC BY asks for: the title, the author, the license and a link to the original.
 */
export function creditsText(
  samples: Record<string, Pick<UserSample, "source">>
): string | null {
  const sources = creditedSources(samples);
  if (sources.length === 0) {
    return null;
  }
  const lines = sources.map(
    (s) =>
      `- "${s.name}" by ${s.author}, CC BY (Creative Commons Attribution, the version is named on the page), ${s.url}`
  );
  return [
    CREDITS_HEADER,
    "",
    "This project contains sounds from Freesound.org under the Creative Commons Attribution license (CC BY).",
    "Show these credits where your game lists its credits:",
    "",
    ...lines,
    "",
  ].join("\n");
}
