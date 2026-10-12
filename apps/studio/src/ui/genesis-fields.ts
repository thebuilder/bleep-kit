/* The Genesis part of a song's master section: the DAC switch. With it on, FM channel 6 plays samples (the chip's PCM
   mode: 8 bit, mono, around 13 kHz), so the channel's kind changes from fm to sample and it takes sample instruments
   (a drum kit, a bass sample, a recording); with it off it is a normal FM voice again. */
import type { Instrument, Song } from "../lib/contract.ts";
import { project } from "../state/docs.ts";
import { note, toggleField } from "./fields.ts";

const DAC_CHANNEL = "fm6";

function withoutGenesis(master: Song["master"]): Song["master"] {
  const { genesis: _dropped, ...rest } = master;
  return rest;
}

/** Switch the DAC on or off in place: the flag, the channel's kind, and an instrument that no longer fits is dropped. */
function setDac(song: Song, on: boolean): void {
  if (on) {
    song.master.genesis = { dac: true };
  } else {
    song.master = withoutGenesis(song.master);
  }
  const kind = on ? "sample" : "fm";
  for (const ch of song.channels) {
    if (ch.id === DAC_CHANNEL && ch.kind !== kind) {
      ch.kind = kind;
      const inst = ch.instrument
        ? (project.instruments()[ch.instrument] as Instrument | undefined)
        : undefined;
      if (inst && inst.kind !== kind) {
        ch.instrument = null;
      }
    }
  }
}

/** The Genesis controls of the master section. `edit` changes the song in place. */
export function genesisFields(
  body: HTMLElement,
  song: Song,
  edit: (fn: (d: Song) => void, key: string) => void,
  rebuild: () => void
): void {
  toggleField(body, {
    label: "FM 6 plays samples (DAC)",
    onInput: (on) => {
      edit((d) => setDac(d, on), "genesis-dac");
      rebuild();
    },
    value: song.master.genesis?.dac === true,
  });
  note(
    body,
    song.master.genesis?.dac
      ? "Channel fm6 is the DAC: sample instruments, 8 bit mono at about 13 kHz. The other five FM voices and the PSG are unchanged."
      : "Switch the DAC on to play drum samples on channel fm6 and give up its FM voice."
  );
}
