/* High level playback: the calls that combine the project's documents with the engine. Views and the sidebar use these. */
import { app } from "./app.ts";
import { engine } from "./engine/engine.ts";
import type { Instrument, Sfx, Song, UserSample } from "./lib/contract.ts";
import { chipChannels } from "./lib/core.ts";
import { fire } from "./lib/dom.ts";
import { framesOf, instrumentFor } from "./lib/sample-edit.ts";
import { type Doc, project } from "./state/docs.ts";

function unlockAudio(): void {
  fire(engine.unlock());
}

export function playSfx(
  doc: Doc,
  opts: { velocity?: number; pitch?: number } = {}
): number {
  unlockAudio();
  return engine.triggerSfx(doc.id, doc.value as Sfx, opts);
}

/** Trigger a sound that is not a project document (a mutation variant). */
export function playSfxValue(id: string, sfx: Sfx): number {
  unlockAudio();
  return engine.triggerSfx(id, sfx);
}

export function loadSongDoc(doc: Doc): readonly string[] {
  const song = doc.value as Song;
  const ids = chipChannels(song).map((c) => c.id);
  const insts = project.instruments();
  engine.loadSong(song, insts, ids, doc.id);
  return ids;
}

/**
 * Play a song that is not a project document (an example) with the instruments it brings. `id` names it for the engine
 * (`engine.hasSong(id)`); it must not collide with a document id. The project is not touched.
 */
export function playSongValue(
  id: string,
  song: Song,
  instruments: Record<string, Instrument>,
  samples: Record<string, UserSample> = {}
): void {
  unlockAudio();
  // an example's samples live under ids of their own, so they never replace the project's samples of the same name
  const tag = (sid: string) => `example:${sid}`;
  const tagged = Object.fromEntries(
    Object.entries(instruments).map(([iid, inst]) => {
      const sid = inst.sample?.userSample;
      return [
        iid,
        inst.sample && sid !== undefined && sid in samples
          ? { ...inst, sample: { ...inst.sample, userSample: tag(sid) } }
          : inst,
      ];
    })
  );
  engine.loadSong(
    song,
    tagged,
    chipChannels(song).map((c) => c.id),
    id,
    Object.fromEntries(Object.entries(samples).map(([sid, s]) => [tag(sid), s]))
  );
  engine.playSong({});
}

export function playSongDoc(
  doc: Doc,
  from?: { order?: number; row?: number }
): void {
  unlockAudio();
  loadSongDoc(doc);
  engine.playSong(from ?? {});
}

let noteTimer: ReturnType<typeof setTimeout> | undefined;
let heldChannel = -1;
export function playInstrumentDoc(doc: Doc, note = 60, duration = 0.5): void {
  unlockAudio();
  const inst = doc.value as Instrument;
  releaseNote();
  heldChannel = engine.previewNoteOn(doc.id, inst, note);
  engine.announce({
    channel: heldChannel,
    hz: 440 * 2 ** ((note - 69) / 12),
    id: doc.id,
    note,
    type: "noteOn",
    velocity: 0.9,
  });
  clearTimeout(noteTimer);
  noteTimer = setTimeout(releaseNote, duration * 1000);
}

/**
 * Play a note in the song editor: on the song's own channel `channel` (the engine's index of it), through the
 * instrument `inst`. The song stays loaded, so what plays and what the other channels hold are not touched. Without a
 * `duration` the note is held until releaseNote() (a mouse press on the keyboard).
 */
export function auditionSongNote(
  song: Doc,
  channel: { index: number; id: string },
  inst: Doc,
  note: number,
  duration?: number
): void {
  if (channel.index < 0) {
    return;
  }
  unlockAudio();
  releaseNote();
  // something else (an instrument preview) may have unloaded the song since the editor loaded it
  if (!engine.hasSong(song.id)) {
    loadSongDoc(song);
  }
  engine.songNoteOn(channel.index, inst.id, inst.value as Instrument, note);
  heldChannel = channel.index;
  engine.announce({
    channel: channel.index,
    channelId: channel.id,
    hz: 440 * 2 ** ((note - 69) / 12),
    id: inst.id,
    note,
    type: "noteOn",
    velocity: 0.9,
  });
  clearTimeout(noteTimer);
  if (duration !== undefined) {
    noteTimer = setTimeout(releaseNote, duration * 1000);
  }
}

export function releaseNote(): void {
  if (heldChannel >= 0) {
    engine.noteOff(heldChannel);
    engine.announce({ channel: heldChannel, type: "noteOff" });
    heldChannel = -1;
  }
}

/** The id of the instrument the sample editor and the sidebar play a sample through. */
const samplePreviewId = (id: string): string => `sample-preview:${id}`;

/**
 * Hold `note` on a sample with no song around: through a sample instrument that plays it at its base note. The preview
 * runs on the custom chip, which plays the sample at full quality; an Amiga song plays the 8 bit copy.
 */
export function previewSampleNote(doc: Doc, note: number): number {
  unlockAudio();
  const sample = doc.value as UserSample;
  const inst = instrumentFor(doc.id, sample, null);
  // a one shot sounds at once and rings out; the instrument's own envelope must not cut it short
  inst.envelope = { attack: 0, decay: 0, release: 0.05, sustain: 1 };
  return engine.previewNoteOn(samplePreviewId(doc.id), inst, note);
}

/** The play button of a sample row: its base note, held for the length of the sample (at most four seconds). */
function playSampleDoc(doc: Doc): void {
  const sample = doc.value as UserSample;
  releaseNote();
  heldChannel = previewSampleNote(doc, sample.baseNote);
  const seconds = Math.min(
    4,
    Math.max(0.2, sample.loop ? 1.5 : sampleSeconds(sample))
  );
  clearTimeout(noteTimer);
  noteTimer = setTimeout(releaseNote, seconds * 1000);
}

const sampleSeconds = (s: UserSample): number => framesOf(s) / s.rate;

/** The play button on a sidebar row or a server `play` message. */
export function playDoc(doc: Doc): void {
  if (doc.kind === "sfx") {
    playSfx(doc);
  } else if (doc.kind === "song") {
    playSongDoc(doc);
  } else if (doc.kind === "sample") {
    playSampleDoc(doc);
  } else {
    playInstrumentDoc(doc, 60, 0.7);
  }
}

export function stopEverything(): void {
  releaseNote();
  engine.stopAll();
}

export function playRef(ref: string, visual: boolean): void {
  const doc = project.find(ref);
  if (!doc) {
    app.toast(`Cannot play ${ref}: no such document`);
    return;
  }
  if (visual) {
    app.navigate(`#/${doc.kind}/${doc.id}`);
  }
  playDoc(doc);
}
