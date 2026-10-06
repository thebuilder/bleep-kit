/* High level playback: the calls that combine the project's documents with the engine. Views and the sidebar use these. */
import { app } from "./app.ts";
import { engine } from "./engine/engine.ts";
import type { Instrument, Sfx, Song } from "./lib/contract.ts";
import { chipChannels } from "./lib/core.ts";
import { fire } from "./lib/dom.ts";
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
  instruments: Record<string, Instrument>
): void {
  unlockAudio();
  engine.loadSong(
    song,
    instruments,
    chipChannels(song).map((c) => c.id),
    id
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

/** The play button on a sidebar row or a server `play` message. */
export function playDoc(doc: Doc): void {
  if (doc.kind === "sfx") {
    playSfx(doc);
  } else if (doc.kind === "song") {
    playSongDoc(doc);
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
