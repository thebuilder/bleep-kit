# Bleepkit

Chiptune sound effects and music for your browser game, made from plain JSON and a few lines of MML. No samples to hunt down, no DAW to learn. Pick a chip, describe a sound, and Bleepkit renders it, measures it, and exports it as OGG files plus a typed `audio.ts` for your game.

It speaks seven sound chips: NES, Game Boy, C64 SID, Sega Genesis, AdLib OPL2, SNES and the Amiga's Paula. Everything is deterministic (same document, same seed, same sound), so the audio lives in git next to your code and shows up in diffs.

What you get:

- **Sound effects**: an sfxr-style generator with categories (coin, laser, explosion, powerup, hit, jump, blip, door, alarm, teleport, step, zap), a `mutate` command for variations, and an FM mode.
- **Music**: tracker patterns, typed in as one line of MML per channel if you like (it becomes pattern rows, and the studio shows any channel as text again), instrument macros (arpeggios, duty sweeps, vibrato), FM patches, SID filter sweeps, SNES echo, loop points that are gapless in OGG.
- **Your own samples**: import a WAV, MP3 or OGG into the sample editor (trim, loop, tune, bit depth), play it from a sample instrument on the Amiga, SNES, custom chip or the Genesis DAC, and import or export ProTracker `.mod` modules.
- **A studio**: a browser editor with scopes, spectrogram and piano roll that edits the real files on disk and reloads on every change.
- **An assistant in the studio** (bring your own key): ask in plain words for a sound, a song or a change, and an Anthropic or OpenAI model builds it with the same documents, measures it and shows you what it saw. The browser calls the provider directly with your key, and it is billed to your account. See [The studio assistant](#the-studio-assistant).
- **A CLI built for agents and for people without speakers**: every command has `--json`, and `render --analyze --images` reports peak, loudness, pitch, clipping, loop seam and writes spectrogram PNGs, so you can judge a sound without hearing it.
- **A player**: `@bleepkit/player` plays the exported files (or synthesizes the documents live) with buses, fades and loops.

There is a finished example in [`examples/demo`](examples/demo): seven songs (one per chip) and 22 sound effects, with the OGG export committed in `examples/demo/export`.

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

# 5. a song: one MML string per channel (stored as tracker patterns)
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

## Freesound samples

The Samples section's import button opens a dialog with a "From Freesound" tab: a quick browser for Freesound.org's "Instrument samples" with subcategory and tag chips, a one-shot filter, a length limit and sorting. Select a row (or move with the arrow keys) and the sound plays at once; Use imports it as a sample with its author and license remembered. CC0 sounds are shown by default, CC BY ones behind a switch (they need credit: the project zip and the game audio export write a `CREDITS.txt`). Anything NonCommercial is never shown. The sounds come from [Freesound.org](https://freesound.org).

It needs a Freesound API key, kept on the server and never sent to the browser. Get one by applying for an API credential at https://freesound.org/apiv2/apply, then, in the repository:

```sh
cp apps/studio/.env.example apps/studio/.env.local
# put the credential's "Client secret / Api key" after FREESOUND_CLIENT_SECRET=
pnpm dev
```

`.env.local` is gitignored; `pnpm bleepkit studio` reads it too (from the folder you run it in, or next to the built studio). On Vercel set `FREESOUND_CLIENT_SECRET` under Environment Variables: the function is in `apps/studio/api/freesound` (and the same file in `api/freesound`, for a project whose Root Directory is the repository root). Without a key the tab says it is not set up and everything else works.

To try the tab with no key and no network, run `FREESOUND_FIXTURES=1 pnpm dev`: it answers with made-up sounds. Freesound's terms allow free use of its API for non-commercial purposes only, so check them before running this in a commercial deployment. Design: section 13 of [docs/architecture.md](docs/architecture.md).

## The studio assistant

The studio has an assistant drawer (the speech bubble in the top bar, or Ctrl+J). It needs an API key from [Anthropic](https://console.anthropic.com) or [OpenAI](https://platform.openai.com/api-keys); open the settings from the drawer, the project menu or the command palette (Ctrl+K), paste the key and pick a model from the list your key can use.

- **Your key stays in this browser.** Requests go straight from the page to the provider (`api.anthropic.com` or `api.openai.com`) and are billed to your account. There is no Bleepkit server in between, and the key is never logged or put in the project. It is kept for the session by default; tick "Remember on this device" to keep it in this browser's localStorage, and press "Forget key" to remove it.
- **Real edits.** The assistant reads and writes the same documents you edit, so its changes show up live, autosave, and undo with Ctrl+Z (one assistant turn is one undo step). It cannot save an invalid document: the same checks as the CLI refuse it and tell the model what is wrong.
- **It cannot hear, and says so.** It renders what it makes, reads the loudness, clipping, pitch and loop numbers, and looks at the waveform and spectrogram. You listen and tell it how it feels.
- **Deleting asks you.** A delete opens the same confirm dialog as the Delete button, and the assistant says in its reply when something was deleted.

Try "Make a coin sound for the NES", "Write a 16-bar Game Boy town theme" or, with a song open, "Make the bass in this song fuller". The code is in `packages/agent` (tools, prompt, provider adapters, loop) and `apps/studio/src/assistant`; the design is in section 12 of [docs/architecture.md](docs/architecture.md).

## The chips

| chip | channels | what it sounds like |
| --- | --- | --- |
| `nes` | 2 pulse (duty 12.5, 25, 50, 75 percent), triangle, noise | Bright, buzzy pulse leads, a round fixed-volume triangle for bass, hissy LFSR noise for drums. Arpeggios stand in for chords. Slightly out-of-tune high notes, like the real thing. |
| `gameboy` | 2 pulse, 32-step 4-bit wave, noise, hard left/right/center pan | Thinner and cuter than the NES, with a lo-fi wavetable voice for bass or a music-box lead and crunchy noise hats. |
| `c64` | 3 SID voices (triangle, saw, pulse with PWM, noise), one shared lp/bp/hp filter | Fat, moving pulse-width leads, resonant filter sweeps, ring mod and sync. A distinctly analog, slightly dirty sound. |
| `genesis` | 6 four-operator FM voices, 3 PSG squares, PSG noise | Glassy bells, slap bass, warm FM pads and electric pianos, plus the thin PSG square for sparkle and drums. |
| `adlib` | 9 two-operator FM voices (OPL2 waveforms) | The PC game sound: buzzy "distortion guitar" and organ, hard metallic leads, a crisp DOS-shooter drum kit. |
| `snes` | 8 sample channels, echo and reverb on the master | Soft, orchestral, a little muffled: strings, choir, bell, timpani, pluck bass, with a long echo tail that glues it together. |
| `amiga` | 4 eight-bit sample channels (Paula), hard panned, period-register pitch, A500 lowpass and LED filter | Tracker music: chunky 8-bit samples, bass and arps from single-cycle waves, crisp drum hits, the ProTracker `.mod` import and export. |
| `custom` | any kind on any channel | No chip limits and free pan. For when you want to break the rules. |

Sound effects pick their chip too (`new sfx hit --category hit --chip genesis`), so the same category sounds different on each one.

## Repository layout

```
packages/core     the audio engine, chips, encoders, analysis (pure TypeScript, runs in Node and the browser)
packages/sfx      the sound effect generators and mutation
packages/agent    @bleepkit/agent: tools, system prompt, provider adapters and loop for the studio assistant (browser safe)
packages/player   @bleepkit/player: the Web Audio player and AudioWorklet for games
packages/cli      the bleepkit command
apps/studio       the studio (Vite app), talks to the CLI's studio server or runs standalone; server/ and api/ hold the Freesound function
api/              the Vercel entry point of that function, for a Root Directory at the repository root
examples/demo     a finished project: 7 songs, 22 sfx, committed OGG export
docs/             architecture.md: documents, engine, CLI and manifest in detail
scripts/          check-packages.ts: packs the packages and runs them in a scratch project
```

A Bleepkit project is a folder of JSON documents:

```
project.json      chip, sample rate, seed, export settings
sfx/*.json        sound effects
instruments/*.json instruments (pulse, wave, SID, FM, sample)
samples/*.json    your recordings (mono PCM as base64) that sample instruments play
songs/*.json      songs (tracker patterns; MML in a channel is accepted and converted)
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
| `import <file.mod>` / `import sample <file.wav>` | turn a ProTracker module into an amiga song with its samples, or a WAV into a user sample for the chip (`--base-note`) |
| `resample <ref>` | render an sfx, song or instrument note and store it as a user sample (`--bits 8 --rate 11025` for the sampler crunch) |
| `mutate <sfx> [--count]` | write variations of an sfx |
| `validate [ref]` | check documents, exit 1 on errors |
| `list [sfx\|songs\|instruments]` | list documents and their renders |
| `render [ref...]` | render to `out/`, with `--analyze`, `--images`, `--stems`, `--format ogg` |
| `analyze <ref\|file.wav>` | peak, loudness, pitch, loop seam, envelope |
| `describe <ref>` | explain a document in words and numbers |
| `play <ref>` | play a document in a running studio tab |
| `export mod <song>` | write an amiga song as a 4 channel ProTracker `.mod` |
| `export` | encode everything, write the audio folder and `audio.ts` (`--embed`, `--clean`, `--dry-run`) |
| `studio [dir]` | start the studio server (`--port`, `--no-open`, `--api-only`) |
| `help formats\|workflow` | the format reference and the no-ears workflow |

Add `--json` to any CLI command for one JSON object on stdout, `-q` to silence progress, `--project <dir>` to choose the project.

## For AI agents

Bleepkit is designed to be driven by an agent that cannot hear. The loop is: write or generate a document, `render --analyze --images`, read the numbers (peak, LUFS, pitch track, loop seam, clipping) and look at the spectrogram and scope PNGs, then adjust. Songs are loopable when `analyze` reports `seamDiffDb` below -40 dB. [AGENTS.md](AGENTS.md) has the working rules for this repository and for using the toolkit, and `pnpm bleepkit help workflow` is the step-by-step version.

The demo project is also a worked example of that loop, with its mix levels set from per-channel stems rather than by ear.

## License

ISC
