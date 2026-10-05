# @bleepkit/player

Plays the audio Bleepkit makes for your browser game: sound effects, looping music, buses and volume, and note events you can use to drive visuals. It sits on the Web Audio API and, optionally, an AudioWorklet that synthesizes the sounds live.

## Install

```sh
pnpm add @bleepkit/player
```

You also need the audio itself. In your game repo run `bleepkit export`: it writes the sound files to `public/audio/` and a typed manifest to `src/audio.ts`.

## Quick start (Vite)

```ts
import { createPlayer } from "@bleepkit/player";
import workletUrl from "@bleepkit/player/worklet?url"; // only needed for synth mode, harmless otherwise
import { manifest } from "./audio";

const player = await createPlayer({ manifest, workletUrl });

addEventListener("pointerdown", () => player.sfx("coin"));
```

`?url` makes Vite serve the worklet file as it is in dev and copy it as an asset in the build. Without `workletUrl` the player looks for `worklet/bleepkit-worklet.js` next to the package, which works for plain `<script type="module">` pages served from `node_modules`.

## Unlock audio on the first gesture

Browsers keep an `AudioContext` suspended until the user interacts with the page. The player resumes it for you on the first pointer, key or touch event. You can also do it yourself, for example from a "Start" button:

```ts
startButton.onclick = async () => {
  await player.resume();
  await player.music("title", { fadeIn: 1 });
};
```

Pass `unlockOnGesture: false` to turn the automatic resume off. Sounds requested while the context is suspended play as soon as it resumes.

## Files or synth

`mode` decides how sound is produced:

| mode | what happens | needs |
| --- | --- | --- |
| `"files"` | plays the exported `.ogg` / `.mp3` files | files in `public/audio/` |
| `"synth"` | sends the documents to the worklet, which plays them like a chip would | `bleepkit export --embed`, `workletUrl` |
| `"auto"` (default) | synth when the manifest embeds documents, files otherwise | |

Files mode is the small, simple choice: nothing runs in the audio thread but the browser's own decoder. Synth mode has no downloads at all and starts instantly, and it is what to use on Safari when your files are OGG (see below). Both modes give you the same API. A single sound without an embedded document falls back to its file.

In synth mode the player runs two engines, one for sound effects and one for music, so the `sfx` and `music` volumes stay independent.

Call `preload()` while your game shows its loading screen. It decodes the files (files mode) or compiles the documents (synth mode), so the first `sfx()` call plays at once:

```ts
await player.preload();               // everything
await player.preload(["coin", "title"]); // or just some
```

A sound effect asked for before its file has arrived plays once it loads, unless that takes more than a second.

## The typed manifest

`src/audio.ts` exports a `manifest`. Pass it to `createPlayer` and the ids you can play become the manifest's keys, checked by TypeScript:

```ts
const player = await createPlayer({ manifest });

player.sfx("coin");      // ok
player.sfx("coinn");     // type error: not a sound in your project
player.music("title");   // ok, and only song ids are accepted here
```

This works when `manifest` keeps its literal keys (`export const manifest = { ... } satisfies AudioManifest`). If your `audio.ts` annotates it as plain `AudioManifest`, the ids are plain strings; you can still narrow the player yourself with the id types the file exports:

```ts
import type { BleepPlayer } from "@bleepkit/player";
import type { SfxId, SongId } from "./audio";

const player: BleepPlayer<SfxId, SongId> = await createPlayer({ manifest });
```

No bundled `audio.ts`? Load the exported `manifest.json` instead (ids are strings then):

```ts
import { createPlayer, loadManifest } from "@bleepkit/player";

const player = await createPlayer({ manifest: await loadManifest("/audio/manifest.json") });
```

## Sound effects

```ts
const shot = player.sfx("laser", { velocity: 0.8, pan: -0.3, pitch: 2 });
shot.stop();
```

`velocity` is 0 to 1, `pan` is -1 (left) to 1 (right), `pitch` is in semitones. `loop: true` repeats a file sound until you `stop()` it (files mode only; in synth mode call `stop()` to release a held sound).

Polyphony is capped so a burst of explosions cannot bury the mix: at most 4 instances of one sound at a time (`maxInstancesPerSfx`) and 8 sound effects in all (`maxSfxVoices`). The oldest is cut short with a few milliseconds of fade.

## Music: loops and fades

```ts
const song = await player.music("title", { fadeIn: 1.5 });
// later
player.stopMusic({ fadeOut: 2 });     // or song.stop({ fadeOut: 2 })
```

- A song that has a loop section in its manifest (`loopStart`, `loopEnd`) plays its intro once, then repeats the loop section with no gap. Files mode does this on the audio buffer itself, so the loop is sample accurate. Use OGG for seamless loops; MP3 loop points are approximate.
- `loop: false` plays the song once, `loop: true` on a song without a loop section repeats the whole song.
- `startAt` starts from a position in seconds, for example to resume a track.
- One song plays at a time. Starting a song while another plays fades the old one out over `fadeIn` as the new one fades in (files mode); in synth mode the old song gets a 40 ms fade before the next one starts.
- `song.position()` gives the current `{ order, row }` when the song has an events file (files mode) or in synth mode, and `null` otherwise.

Volumes: three buses, `"sfx"`, `"music"` and `"master"`, each 0 to 1.

```ts
player.setVolume("music", 0.4, 1);   // glide to 40% over a second
player.mute(true);                   // silence everything, remembers the master volume
```

## React to notes and sounds for visuals

```ts
const off = player.on("noteOn", (e) => {
  flashLane(e.channel, e.velocity);   // e.channelId is "pulse1", "triangle", ...
});

player.on("trigger", (e) => burstAt(e.id));        // a sound effect started
player.on("row", (e) => highlightRow(e.row));      // the tracker row changed
player.on("loop", () => console.log("looped"));
player.on("end", () => player.music("next"));

off(); // stop listening
```

Listeners are called when the event is audible, not when it is generated, so visuals line up with what the player hears. `e.time` is the `AudioContext` time of the event. In files mode the events come from the `<song>.events.json` file next to each song (`export.events` is on by default), replayed against the moment the song started, loops included.

Event types: `noteOn`, `noteOff`, `trigger`, `row`, `loop`, `end`.

## Safari

Safari cannot decode OGG Vorbis, which is Bleepkit's default file format. You have two options:

1. **Synth mode (recommended).** Export with `embed: true`. The manifest carries the documents, so there are no audio files to decode, and `"auto"` mode picks the worklet on every browser.
2. **MP3.** Set both `sfxFormat` and `musicFormat` to `"mp3"`. Loop points become approximate, so music may click or gap at the loop.

`loadManifest` and `createPlayer` warn (through `onError`, default `console.warn`) when the manifest lists OGG files the browser cannot decode. `supportsOgg()` tells you the same thing:

```ts
import { supportsOgg } from "@bleepkit/player";
```

Other things Safari does:

- It only resumes an `AudioContext` from inside a user gesture handler. The automatic unlock handles this; if you call `resume()` yourself, do it directly in the event handler, not after an `await`.
- It does not report `outputLatency`, so event times use `baseLatency` and can be a few tens of milliseconds early.
- SharedArrayBuffer needs cross-origin isolation, which only matters for the studio's scopes; the game player never uses it.

## Options and errors

```ts
createPlayer({
  manifest,
  workletUrl,
  context,                  // your own AudioContext (otherwise one is created)
  mode: "auto",
  buses: { master: 1, music: 0.8, sfx: 1 },
  maxSfxVoices: 8,
  maxInstancesPerSfx: 4,
  unlockOnGesture: true,
  onError: (error) => report(error),  // default: console.warn
});
```

Audio problems never throw into your game loop: an unknown id, a missing file or a worklet error goes to `onError`, and the call returns a handle that does nothing. Call `player.dispose()` when you are done; it stops everything and closes a context the player created.
