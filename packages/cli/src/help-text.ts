// Reference text for `bleepkit help formats` and `bleepkit help workflow`. Written to be read by an agent in a fresh
// session: every document format, the MML notation and the effect codes in one screen of text. Kept consistent with
// docs/architecture.md sections 2.3 to 2.7; enumerations come from the frozen types so they cannot drift.
import {
  CHANNEL_KINDS,
  CHIP_IDS,
  EFFECT_TYPES,
  SFX_CATEGORIES,
  SFX_WAVES,
} from "@bleepkit/core";

export const FORMAT_SECTIONS = [
  "overview",
  "project",
  "sfx",
  "instrument",
  "song",
  "rows",
  "effects",
  "mml",
] as const;
export type FormatSection = (typeof FORMAT_SECTIONS)[number];

const overview = `BLEEPKIT DOCUMENT FORMATS
Everything is plain JSON in a project folder (default ./audio). Sections: ${FORMAT_SECTIONS.join(", ")}.
Show one with: bleepkit help formats <section>

  project.json            settings: chip, sample rate, seed, export paths and formats
  sfx/<id>.json           one-shot sound effect (sfxr style parameters)
  instruments/<id>.json   an instrument: envelope, macros, kind specific patch
  songs/<id>.json         channels + patterns (tracker rows) and/or MML text per channel
  out/                    renders (wav masters, .events.json, .meta.json, analysis png); never edit

Rules for every document
  * The id is the file name without .json: lowercase letters, digits, dashes (^[a-z0-9][a-z0-9-]{0,63}$).
  * "version": 1 in every document. "name" is a free label.
  * Units: seconds for time, Hz for frequency, 0..1 for levels, MIDI note numbers for pitch (60 = C-4 = 261.63 Hz,
    69 = A-4 = 440 Hz), cents for fine pitch, semitones for coarse pitch, pan -1 (left) to 1 (right).
  * Missing fields get defaults, numbers out of range are clamped with a warning, wrong types are errors.
    Run \`bleepkit validate\` after every edit: it prints one line per problem with a JSON pointer path.
  * References on the command line: sfx/coin, song/title, instrument/lead (a bare id works when it is unambiguous).

Enumerations
  chips        ${CHIP_IDS.join(" | ")}
  channel kind ${CHANNEL_KINDS.join(" | ")}
  sfx category ${SFX_CATEGORIES.join(" | ")}
  sfx wave     ${SFX_WAVES.join(" | ")}
  Chips: nes (2 pulse, triangle, noise) | gameboy (2 pulse, wave, noise) | c64 (3 sid voices) |
         genesis (6 fm + 3 psg pulse + psgNoise) | adlib (9 fm, 2 operator) | snes (8 sample channels) | custom (any)`;

const project = `PROJECT  project.json
{ "version": 1, "name": "Deep Reach", "chip": "genesis", "sampleRate": 48000, "seed": 7,
  "master": { "volume": 0.8, "limiter": true },
  "export": { "dir": "../public/audio", "manifest": "../src/audio.ts", "baseUrl": "/audio/",
              "sfxFormat": "ogg", "musicFormat": "ogg", "oggQuality": 6, "mp3Bitrate": 160,
              "events": true, "embed": false } }
  chip         default chip for new documents
  sampleRate   44100 or 48000 (render rate)
  seed         root seed for \`new\` and \`mutate\` (same seed, same result)
  export.dir / export.manifest   relative to the project folder; \`bleepkit export\` writes audio files and audio.ts
  export.*Format  wav | ogg | mp3 (ogg loops gaplessly, mp3 does not; see \`bleepkit export --help\`)
  export.embed    true puts the JSON documents into the manifest so the player can synthesize without files`;

const sfx = `SFX  sfx/<id>.json  (rendered through the same engine as instruments)
{ "version": 1, "name": "Coin", "category": "coin", "chip": "nes", "seed": 1234, "wave": "square", "volume": 0.6,
  "frequency": { "start": 1046.5, "min": 0, "slide": 0, "deltaSlide": 0 },
  "vibrato": { "depth": 0, "rate": 0 },
  "arpeggio": { "steps": [7], "rate": 14 },
  "envelope": { "attack": 0, "sustain": 0.06, "punch": 0.4, "decay": 0.25 },
  "duty": { "start": 0.5, "sweep": 0 }, "repeat": { "rate": 0 },
  "phaser": { "offset": 0, "sweep": 0 },
  "filter": { "lowpass": null, "lowpassSweep": 0, "resonance": 0, "highpass": null, "highpassSweep": 0 },
  "bitcrush": { "bits": null, "rateDivide": 1 }, "noise": { "mode": "long" }, "fm": null, "table": null }
Ranges
  volume 0..1 | frequency.start 20..8000 Hz | min 0..8000 (sound stops when pitch slides below it, 0 = off)
  slide -8..8 octaves/s | deltaSlide -16..16 octaves/s^2 | vibrato.depth 0..2 semitones, rate 0..40 Hz
  arpeggio.steps up to 8 semitone offsets (-24..24) cycled at rate 0..60 Hz
  envelope: attack 0..2 s, sustain 0..3 s, decay 0..3 s, punch 0..1 (total max 10 s)
  duty.start 0..1 (square only), sweep -4..4 per second | repeat.rate 0..60 Hz (retrigger, 0 = off)
  phaser.offset -20..20 ms, sweep -40..40 ms/s | filter cutoffs in Hz (null = off), sweeps in octaves/s
  bitcrush.bits 1..16 or null, rateDivide 1..64
  wave "fm" needs fm: { "ratio": 0.5..12, "index": 0..8, "indexDecay": 0..2 }; wave "wave" needs table: 32 integers 0..15
Which waves a chip allows: nes square|triangle|noise; gameboy square|wave|noise; c64 square|saw|triangle|noise;
  genesis square|noise|fm; adlib fm|square|sine|saw; snes sine|triangle|saw|square|noise; custom all.
Start with \`bleepkit new sfx <id> --category coin\` and edit the JSON, or \`bleepkit mutate sfx/<id>\` for variations.`;

const instrument = `INSTRUMENT  instruments/<id>.json
{ "version": 1, "name": "Lead", "kind": "pulse", "chip": "nes", "volume": 0.8, "pan": 0,
  "transpose": 0, "finetune": 0,
  "envelope": { "attack": 0, "decay": 0.15, "sustain": 0.6, "release": 0.04 },
  "macros": { "volume": { "values": [1, 1, 0.9, 0.8], "loop": -1, "release": -1 },
              "arpeggio": { "values": [0, 0, 12, 0], "loop": 0, "release": -1 }, "arpeggioMode": "offset",
              "duty": { "values": [2, 2, 1, 1, 0], "loop": 3, "release": -1 } },
  "send": { "echo": 0, "reverb": 0 },
  "pulse": { "duty": 0.5 }, "wave": null, "noise": null, "sid": null, "fm": null, "sample": null }
  kind picks the one patch block that must be non-null: pulse->pulse, wave->wave {table: 32 values 0..15},
    noise->noise {mode: long|short}, sid->sid, fm->fm, sample->sample, triangle->none (others null).
  chip: the chip it was designed for, or null for any chip with this kind.
  envelope: attack/decay/release seconds, sustain level 0..1. transpose -48..48 semitones, finetune -100..100 cents.
  macros: one value per engine tick (60 Hz). values 1..256 entries; loop = index to jump back to after the last
    value (-1 holds the last value); release = index to jump to on note off (-1 none).
    volume 0..1 multiplier | arpeggio semitone offsets (or absolute notes when arpeggioMode "fixed") |
    pitch cents per tick | duty index into the chip's duty list | pan -1..1.
  triangle kind: no volume on hardware, level above 0.5 is on, else off.
  fm patch: { "algorithm": 0..7 (4 op) or 0..1 (2 op), "feedback": 0..7, "lfo": null | {rate, pitchDepth, ampDepth},
    "ops": [ { "mult": 0..15, "detune": -3..3, "level": 0..1, "attack": 0..31, "decay": 0..31, "sustainLevel": 0..1,
               "sustainRate": 0..31, "release": 0..15, "keyScale": 0..3, "waveform": 0..7, "fixedHz": null } x2 or x4 ] }
  sample patch (snes): { "generator": kick|snare|hat|tom|clap|crash|pluck|bass|pad|organ|bell|strings|choir|lead,
    "params": {}, "seed": 3, "baseNote": 60, "loop": false }
  sid patch: { "waveforms": ["tri"|"saw"|"pulse"|"noise", ...], "pulseWidth": 0..1, "pwmRate": 0..20, "pwmDepth": 0..1,
    "ring": false, "sync": false, "filter": { "mode": "off"|"lp"|"bp"|"hp", "cutoff": 0..1, "resonance": 0..1, "sweep": 0 } }
Start with \`bleepkit new instrument <id> --kind pulse --preset lead\` (presets: lead bass drums pad bell).`;

const song = `SONG  songs/<id>.json
{ "version": 1, "name": "Title", "chip": "nes", "tempo": 150, "rowsPerBeat": 4, "tickRate": 60,
  "channels": [
    { "id": "pulse1", "kind": "pulse", "instrument": "lead", "volume": 1, "pan": 0, "mml": null, "muted": false },
    { "id": "noise", "kind": "noise", "instrument": "drums", "volume": 0.7, "pan": 0,
      "mml": "l8 @drums o3 [c r d r c c d r]4 L [c r d r c c d d]8", "muted": false } ],
  "patterns": { "intro": { "length": 32, "tracks": { "pulse1": [
      { "row": 0, "note": 72, "inst": "lead", "vol": 15, "fx": [] }, { "row": 4, "s": "E-5 . . 047" }, { "row": 14, "s": "OFF" } ] } } },
  "order": ["intro"], "loop": 0, "master": { "volume": 0.8, "echo": null, "reverb": null } }
  tempo 20..400 BPM (quarter notes) | rowsPerBeat 1..16 (a row is 1/rowsPerBeat of a beat) | tickRate 50 or 60
  channels: ids must belong to the chip (nes: pulse1 pulse2 triangle noise; gameboy: pulse1 pulse2 wave noise;
    c64: voice1..3; genesis: fm1..6 psg1..3 psgNoise; adlib: fm1..9; snes: ch1..8); "custom" declares its own.
    instrument = id used until a row or MML @id switches it; it must exist and match the channel kind.
    mml = a text melody for this channel (see: help formats mml); when set, pattern tracks for it are ignored.
  patterns: length 1..256 rows; tracks are sparse row lists per channel id, sorted by row.
  order: pattern ids in play order. loop: order index to loop back to after the last one, or null to play once.
  A song with every channel in MML may have "patterns": {} and "order": [].
Start with \`bleepkit new song <id> --mml 'pulse1=o4 l8 cdefgab>c'\` and edit.`;

const rows = `ROWS  pattern rows in a song (compact string form or typed object)
  { "row": 4, "s": "E-5 lead vC 047" }   fields: <note> [<inst>] [<vol>] [<fx>...] separated by spaces
    note   C-4 C#4 Db4 n60 (MIDI number) OFF (cut) REL (release) ... (none)
    inst   an instrument id, or . to keep the current one
    vol    v0..vF (hex 0..15), or . for unchanged
    fx     up to 4 tracker codes like 047 or A0F (see: help formats effects)
  Typed form: { "row": 0, "note": 72, "inst": "lead", "vol": 15, "fx": [ { "type": "arp", "x": 0, "y": 7 } ] }
    note is a MIDI number, "off", "release" or null; inst and vol may be null (keep current); up to 4 fx.
  Rows are sorted by row and unique; row < the pattern length. 60 = C-4, 72 = C-5.`;

const effects = `EFFECTS  tracker codes (<letter><two hex digits>); typed form { "type", "x", "y" } with xx = x*16+y
  0xy arp           cycle base, +x, +y semitones one step per tick; 000 stops
  1xx slideUp       pitch up xx sixteenths of a semitone per tick
  2xx slideDown     pitch down xx sixteenths per tick
  3xx portamento    slide toward each new note at xx sixteenths per tick; 300 off
  4xy vibrato       speed x (0 = off), depth y * 8 cents
  7xy tremolo       speed x, depth y/15 of volume
  Axy volSlide      volume +x -y sixteenths per tick (one of x, y is 0)
  Bxx jump          after this row continue at order index xx
  Cxx halt          stop the song after this row
  Dxx skip          after this row continue at row xx of the next order entry
  Fxx tempo         set tempo to xx BPM (hex, 0x20..0xFF)
  Vxx duty          pulse duty index, wave index, sid waveform mask, fm algorithm
  Pxx pitch         fine pitch offset (xx - 0x80) sixteenths of a semitone
  Sxx cut           note off after xx ticks
  Gxx delay         trigger this row's note xx ticks late
  Qxy noteSlideUp   slide up y semitones at speed x
  Rxy noteSlideDown slide down y semitones at speed x
  Xxx pan           00 left, 80 center, FF right
  Wxx send          echo send level xx/255 (chips with master effects)
  Hxx retrigger     retrigger the note every xx ticks
  Persistent effects (arp, vibrato, tremolo, volSlide, slides, portamento, retrigger) stay on until the same letter
  appears with 00, and stop at a note off. Effect types: ${EFFECT_TYPES.join(" ")}.`;

const mml = `MML  one string per channel (song.channels[i].mml); whitespace ignored, ; starts a comment
  c d e f g a b   a note; + or # sharp, - flat; optional length 1 2 4 8 16 32 64 and dots (c4. = dotted quarter)
  &               tie into the next note without retrigger (c4&c8)
  n<midi>         note by MIDI number, optional length (n60 l4)
  r               rest, optional length
  o<0-8>          octave (default 4);  >  octave up;  <  octave down      (o4 c = C-4 = MIDI 60)
  l<n>            default length (default 8 = eighth note)
  v<0-15>         volume (default 15) | p<0-15> pan (0 left, 8 center, 15 right)
  @<id>           switch instrument by id (letters, digits, dashes), e.g. @lead
  q<1-8>          gate: notes sound for q/8 of their length (default 8) | k<n> transpose semitones (k-12)
  t<n>            tempo (sets song tempo when the song has no patterns) | w<n> duty index
  {Axx}           attach a tracker effect (letter + two hex digits) to the next note, e.g. {A0F} or {047}
  [ ... ]<n>      repeat n times (default 2), nesting up to 4
  L               loop point: the song loops back here (one channel is enough, the first L wins). A song with no
                  patterns plays once unless some channel has an L: without it there is no loop and no loop points
  |               bar line, ignored
  Example: "t140 @lead o4 l8 [c e g > c < g e]2 L @lead o5 l4 c d e g"
  Length n lasts 384/n pulses (96 per quarter note); a row lasts 96/rowsPerBeat pulses.
  Parse errors come back from validate with a character offset: error /channels/0/mml: unexpected "x" at 12.`;

export const FORMAT_TEXT: Record<FormatSection, string> = {
  effects,
  instrument,
  mml,
  overview,
  project,
  rows,
  sfx,
  song,
};

export const WORKFLOW_TEXT = `WORKING WITHOUT EARS: the loop an agent should use
  1. bleepkit init                              create ./audio with starter instruments and a sound
  2. bleepkit new sfx jump --category jump      generate a sound (deterministic: same seed, same sound)
  3. bleepkit describe sfx/jump                 read what it is in words (wave, pitch, length, envelope)
  4. bleepkit render sfx/jump --analyze         measure it: peak, loudness, clipping, pitch, spectrum, envelope
     bleepkit analyze sfx/jump --images         also writes waveform/spectrogram PNGs you can look at
  5. Edit sfx/jump.json (or: bleepkit mutate sfx/jump --count 4) and re-render; compare the numbers.
  6. bleepkit validate                          every document, one line per problem, exit 1 on errors
  7. bleepkit export                            render what is stale, encode, write public/audio + src/audio.ts
Use --json on any command for one machine readable object. Exit codes: 0 ok, 1 bad result (validation, clipping with
--strict), 2 usage, 3 no project, 4 file not found, 5 encode or write failure, 6 server could not bind.
What the numbers mean: peak above -1 dB or "clipped" means too loud (lower "volume"); pitch.medianNote tells you the
note you actually made; loop.seamDiffDb below -40 dB is a clean music loop (null means the loop starts too early to compare);
leading/trailing silence should be near 0 for sfx.
Songs: write MML first (help formats mml), render, then check duration and loop.start/loop.end against what you meant.
Have a MIDI file? bleepkit import tune.mid --chip nes   makes songs/tune.json plus midi-<chip>-* instruments, and lists
what the chip could not play (chords keep the top note, notes dropped, parts left out). Re-run with --map "1=pulse1,2=triangle,10=noise"
or --rows-per-beat 8 to steer it, then render --analyze --images and look at the scopes.
Every command has an example: bleepkit <command> --help.`;
