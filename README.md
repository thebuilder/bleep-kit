# Bleepkit

Chiptune sound effects and music for your browser game, made from plain JSON and a few lines of MML. No samples to hunt down, no DAW to learn. Pick a chip, describe a sound, and Bleepkit renders it, measures it, and exports it as OGG files plus a typed `audio.ts` for your game.

It speaks six sound chips: NES, Game Boy, C64 SID, Sega Genesis, AdLib OPL2 and SNES. Everything is deterministic (same document, same seed, same sound), so the audio lives in git next to your code and shows up in diffs.

What you get:

- **Sound effects**: an sfxr-style generator with categories (coin, laser, explosion, powerup, hit, jump, blip, door, alarm, teleport, step, zap), a `mutate` command for variations, and an FM mode.
- **Music**: tracker patterns or one line of MML per channel, instrument macros (arpeggios, duty sweeps, vibrato), FM patches, SID filter sweeps, SNES echo, loop points that are gapless in OGG.
- **A studio**: a browser editor with scopes, spectrogram and piano roll that edits the real files on disk and reloads on every change.
- **A CLI built for agents and for people without speakers**: every command has `--json`, and `render --analyze --images` reports peak, loudness, pitch, clipping, loop seam and writes spectrogram PNGs, so you can judge a sound without hearing it.
- **A player**: `@bleepkit/player` plays the exported files (or synthesizes the documents live) with buses, fades and loops.

There is a finished example in [`examples/demo`](examples/demo): six songs (one per chip) and 22 sound effects, with the OGG export committed in `examples/demo/export`.

## Quick start

You need Node 22.18 or newer and pnpm 10.

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts the studio with hot reload on http://localhost:5173. On its own it runs in standalone mode: the project lives in your browser (IndexedDB) and you can drop in a folder to import it.

To edit a real project folder on disk, such as the demo, also start the CLI's studio server in a second terminal. The Vite dev server proxies `/api` and `/ws` to it on port 5174:

```sh
pnpm bleepkit studio examples/demo --api-only
```

Reload the page at http://localhost:5173 and the demo's songs and sound effects are there. Edit a JSON file in your editor and every open tab updates; save in the studio and the file on disk changes.

Without Vite, build the studio once and let the CLI serve everything (API, websocket and the studio) on one port:

```sh
pnpm build
pnpm bleepkit studio examples/demo
```

That opens http://localhost:5174. Add `--no-open` to skip the browser, `--port <n>` to change the port. `pnpm preview` serves the built studio standalone (no project folder) on http://localhost:4173.

`pnpm bleepkit <args>` runs the CLI from the workspace sources. It looks for a project by walking up from the current directory, and the repo root is not inside one, so pass `--project <dir>` for the demo:

```sh
pnpm bleepkit list --project examples/demo
pnpm bleepkit describe song/space-cruise --project examples/demo
pnpm bleepkit render song/grid-battle --analyze --project examples/demo
```

Rendered files go to `examples/demo/out/` (ignored by git).

## A 60-second CLI tour

Make a project, a sound effect and a tiny song, then check them the way an engineer would who cannot hear:

```sh
# 1. a project folder with starter instruments and one sfx (any chip: nes gameboy c64 genesis adlib snes)
pnpm bleepkit init ~/chip-test --chip nes --name "Chip Test"

# 2. generate a jump sound; the same id and seed always give the same sound
pnpm bleepkit new sfx jump --category jump --project ~/chip-test

# 3. read it in words, then measure the render
pnpm bleepkit describe sfx/jump --project ~/chip-test
pnpm bleepkit render sfx/jump --analyze --images --project ~/chip-test

# 4. want other takes? write variations and compare their descriptions
pnpm bleepkit mutate sfx/jump --count 3 --project ~/chip-test

# 5. a song: one MML string per channel
pnpm bleepkit new song title --tempo 140 \
  --mml pulse1="o4 l8 cdefgab>c" --mml triangle="o2 l4 c g c g" --project ~/chip-test
pnpm bleepkit render song/title --analyze --images --stems --project ~/chip-test

# 6. check every document, then export
pnpm bleepkit validate --project ~/chip-test
pnpm bleepkit export --project ~/chip-test
```

`render --images` writes waveform, spectrogram and (for songs) per-channel scope PNGs to `out/analysis/`. `export` writes OGG files and a typed manifest. By default they land next to the project folder, in `../public/audio/` and `../src/audio.ts`, which is where a Vite game keeps them when the project is `<game>/audio`. Change that with `export.dir` and `export.manifest` in `project.json`, or the `--dir` and `--manifest` flags.

Two help pages teach the rest, and both are written for a reader who starts from nothing:

```sh
pnpm bleepkit help formats    # the JSON documents and the MML syntax on one page
pnpm bleepkit help workflow   # how to work without hearing the audio
```

Every command also has `--help` with examples. Exit codes are stable (1 bad result, 2 usage, 3 no project, 4 not found) and `--json` errors carry a `hint`.

## Using it in a game

In the game repo, set the project up where the game loads its audio from, and run `bleepkit export`. It writes the encoded files and `src/audio.ts`, a typed manifest of every sound and song id. Then:

```sh
pnpm add @bleepkit/player
```

```ts
import { createPlayer } from "@bleepkit/player";
import workletUrl from "@bleepkit/player/worklet?url";
import { manifest } from "./audio";

const player = await createPlayer({ manifest, workletUrl });

addEventListener("pointerdown", () => player.sfx("space-laser"));
await player.music("space-cruise", { fadeIn: 1.5 });
```

- **The manifest is typed.** `player.sfx("space-lazer")` is a type error, and `player.music` only accepts song ids.
- **Files or synth.** `mode: "files"` plays the exported OGG files (small, simple, sample-accurate loops). `mode: "synth"` plays the JSON documents live through an AudioWorklet, with no audio downloads; it needs `bleepkit export --embed`. The default `"auto"` picks synth when the manifest embeds documents.
- **Loops.** Songs with a loop section play the intro once and then repeat the loop with no gap. Use OGG for that, MP3 adds encoder delay.
- **Buses, fades, note events.** `setVolume("music", 0.4, 1)`, `stopMusic({ fadeOut: 2 })`, and an events file for syncing visuals to the music.

The full API (preloading, unlocking audio on the first gesture, polyphony limits, Safari notes) is in [packages/player/README.md](packages/player/README.md).

## The chips

| chip | channels | what it sounds like |
| --- | --- | --- |
| `nes` | 2 pulse (duty 12.5, 25, 50, 75 percent), triangle, noise | Bright, buzzy pulse leads, a round fixed-volume triangle for bass, hissy LFSR noise for drums. Arpeggios stand in for chords. Slightly out-of-tune high notes, like the real thing. |
| `gameboy` | 2 pulse, 32-step 4-bit wave, noise, hard left/right/center pan | Thinner and cuter than the NES, with a lo-fi wavetable voice for bass or a music-box lead and crunchy noise hats. |
| `c64` | 3 SID voices (triangle, saw, pulse with PWM, noise), one shared lp/bp/hp filter | Fat, moving pulse-width leads, resonant filter sweeps, ring mod and sync. A distinctly analog, slightly dirty sound. |
| `genesis` | 6 four-operator FM voices, 3 PSG squares, PSG noise | Glassy bells, slap bass, warm FM pads and electric pianos, plus the thin PSG square for sparkle and drums. |
| `adlib` | 9 two-operator FM voices (OPL2 waveforms) | The PC game sound: buzzy "distortion guitar" and organ, hard metallic leads, a crisp DOS-shooter drum kit. |
| `snes` | 8 sample channels, echo and reverb on the master | Soft, orchestral, a little muffled: strings, choir, bell, timpani, pluck bass, with a long echo tail that glues it together. |
| `custom` | any kind on any channel | No chip limits and free pan. For when you want to break the rules. |

Sound effects pick their chip too (`new sfx hit --category hit --chip genesis`), so the same category sounds different on each one.

## Repository layout

```
packages/core     the audio engine, chips, encoders, analysis (pure TypeScript, runs in Node and the browser)
packages/sfx      the sound effect generators and mutation
packages/player   @bleepkit/player: the Web Audio player and AudioWorklet for games
packages/cli      the bleepkit command
apps/studio       the studio (Vite app), talks to the CLI's studio server or runs standalone
examples/demo     a finished project: 6 songs, 22 sfx, committed OGG export
docs/             architecture.md: documents, engine, CLI and manifest in detail
scripts/          check-packages.ts: packs the packages and runs them in a scratch project
```

A Bleepkit project is a folder of JSON documents:

```
project.json      chip, sample rate, seed, export settings
sfx/*.json        sound effects
instruments/*.json instruments (pulse, wave, SID, FM, sample)
songs/*.json      songs (tracker patterns or MML per channel)
out/              renders and analysis (gitignored)
```

## Commands

Workspace commands, run from the repo root:

| command | what it does |
| --- | --- |
| `pnpm install` | install dependencies |
| `pnpm dev` | run the studio with hot reload (pair with `pnpm bleepkit studio <dir> --api-only` to edit a folder) |
| `pnpm build` | build every package and the studio |
| `pnpm preview` | serve the built studio, standalone |
| `pnpm bleepkit <args>` | run the CLI from the workspace sources |
| `pnpm typecheck` | type-check every package (Turbo) |
| `pnpm check` | lint and formatting (Ultracite) |
| `pnpm fix` | fix lint and formatting |
| `pnpm test` | run the tests (Turbo) |
| `pnpm test:watch` | run the tests in watch mode |
| `pnpm fallow` | unused code, duplication and complexity (Fallow) |
| `pnpm ci:check` | what CI runs: typecheck, lint, Fallow, build (no tests) |
| `pnpm check:packages` | pack the packages and use the tarballs in a scratch project |
| `pnpm verify` | everything: `ci:check` plus the tests and `check:packages`; run it before a release |

CLI commands, `pnpm bleepkit <command>`:

| command | what it does |
| --- | --- |
| `init [dir] [--chip]` | create a project folder with starter documents |
| `new sfx\|instrument\|song <id>` | create a document (sfx from `--category`, songs from `--mml`) |
| `import <file.mid> [--chip] [--rows-per-beat] [--map] [--chords]` | turn a MIDI file into a song for a chip: chords are spread over free channels or become `0xy` arpeggios (`--chords auto\|spread\|arpeggio\|top`), and the report lists what was converted apart from what the chip could not play |
| `mutate <sfx> [--count]` | write variations of an sfx |
| `validate [ref]` | check documents, exit 1 on errors |
| `list [sfx\|songs\|instruments]` | list documents and their renders |
| `render [ref...]` | render to `out/`, with `--analyze`, `--images`, `--stems`, `--format ogg` |
| `analyze <ref\|file.wav>` | peak, loudness, pitch, loop seam, envelope |
| `describe <ref>` | explain a document in words and numbers |
| `play <ref>` | play a document in a running studio tab |
| `export` | encode everything, write the audio folder and `audio.ts` (`--embed`, `--clean`, `--dry-run`) |
| `studio [dir]` | start the studio server (`--port`, `--no-open`, `--api-only`) |
| `help formats\|workflow` | the format reference and the no-ears workflow |

Add `--json` to any CLI command for one JSON object on stdout, `-q` to silence progress, `--project <dir>` to choose the project.

## For AI agents

Bleepkit is designed to be driven by an agent that cannot hear. The loop is: write or generate a document, `render --analyze --images`, read the numbers (peak, LUFS, pitch track, loop seam, clipping) and look at the spectrogram and scope PNGs, then adjust. Songs are loopable when `analyze` reports `seamDiffDb` below -40 dB. [AGENTS.md](AGENTS.md) has the working rules for this repository and for using the toolkit, and `pnpm bleepkit help workflow` is the step-by-step version.

The demo project is also a worked example of that loop, with its mix levels set from per-channel stems rather than by ear.

## License

ISC
