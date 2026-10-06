# Bleepkit: notes for AI agents

Bleepkit generates 80s and 90s style game audio (chiptune and FM era) for browser games. Everything is plain JSON plus a deterministic synth engine, so an agent can author, render and measure audio without hearing it. Read this file first, then `docs/architecture.md` (the design contract) for anything deeper.

## House rules

- Never use the em dash character anywhere: code, comments, docs, JSON, commit messages. Use commas, colons or hyphens.
- Node 22.18 or newer runs the `.ts` sources directly (type stripping). So: no enums, no namespaces, no parameter properties; relative imports end in `.ts`; type-only imports use `import type`.
- `packages/core/src/types.ts` is the contract between every package. Change it only on purpose, and update `docs/architecture.md` (section 2.2) in the same change.
- Determinism: no `Math.random`, `Date`, `performance` or `crypto` in core, sfx or player sources (a test greps for them; `packages/player/src/worklet/load-meter.ts` is the one allowlisted exception). All randomness goes through `mulberry32` / `deriveSeed` from `@bleepkit/core`.
- The realtime path (`Synth.process`) must not allocate.
- Package boundaries: `core` imports nothing at runtime; `core/tools` lazy loads `wasm-media-encoders` only; `player` is the only package touching Web Audio; `cli` is the only package touching the file system and network; the studio never imports the CLI (it talks to its server over HTTP and a websocket).

## Layout

```
packages/core      @bleepkit/core: engine, chips, documents + normalize, MML, sample generators
                   @bleepkit/core/tools: WAV/OGG/MP3, analysis, spectrogram, pitch, PNG images
packages/sfx       @bleepkit/sfx: sfx generators per category, randomize, mutate, describe
packages/player    @bleepkit/player: game runtime (AudioWorklet, files or synth mode, typed manifest)
packages/cli       bleepkit: the CLI and the studio server
apps/studio        the Vite studio (vanilla TypeScript, canvas views, Pixelkit backdrop)
examples/demo      a demo project folder: six songs (one per chip) and 22 sfx, exported OGGs in export/
docs/architecture.md   the contract: formats, engine design, worklet protocol, CLI, studio UX
```

`apps/studio/src/pixelkit/` is vendored from Pixelkit (github.com/thebuilder/pixelstudio) by its own CLI. Do not hand edit it; it is excluded from Fallow.

## Making audio as an agent

You cannot hear, so work from text and measurements:

1. `pnpm bleepkit help workflow` and `pnpm bleepkit help formats` teach the whole document format and MML syntax.
2. Author: `new sfx <id> --category <c> --chip <chip>`, `mutate`, `new song <id> --mml "pulse1=..."`, or edit the JSON in `sfx/`, `songs/`, `instruments/` directly.
3. Check: `validate`, then `describe <ref>` (a precise text description).
4. Measure: `render <ref> --analyze --images`, then look at `out/analysis/<id>.waveform.png`, `.spectrogram.png` and `.scopes.png` with your image reader. `analyze <ref> --json` gives peak, RMS, LUFS, clipping, pitch track, loop seam and envelope.
5. Targets that sound right in practice: songs around -14 to -16 LUFS and within 3 LUFS of each other; sfx peaks between -6 and -16 dBFS; zero clipped frames; loop `seamDiffDb` below -40 dB.
6. Ship: `export` writes OGG (or MP3/WAV), a `manifest.json` and a typed `audio.ts` into the game.

Every command takes `--json` (exactly one JSON object on stdout) and `--project <dir>`. From the repo root use `pnpm bleepkit <args> --project examples/demo`.

When a person is running the studio on the same folder, files you write appear in it live, and `pnpm bleepkit play <ref>` plays a sound in their studio with the visuals.

## Developing

```
pnpm install
pnpm dev                                           # studio on :5173 (proxies /api and /ws to :5174)
pnpm bleepkit studio examples/demo --api-only      # the CLI server for pnpm dev
pnpm verify          # typecheck, check, test:coverage, fallow:check, build, check:packages (what CI runs)
pnpm --filter @bleepkit/core test                  # one package
```

Gotchas learned while building it:

- Lint: Ultracite (Biome). Rules that do not fit DSP or binary code are turned off by path in the root `biome.jsonc` overrides, each with a reason; the studio has a nested `apps/studio/biome.jsonc`. Prefer fixing code over adding ignores. Run `npx ultracite fix <paths>` scoped to what you changed.
- Fallow runs on the coverage file, so `pnpm test:coverage` must pass before `pnpm fallow:check`. Per-sample loops get scoped `thresholdOverrides` with reasons, not blanket ignores.
- Golden tests pin the engine's output by hash. If you change how anything sounds on purpose, bump `ENGINE_VERSION` in `packages/core/src/version.ts`, then run `UPDATE_GOLDEN=1 pnpm --filter @bleepkit/core test`. The version is also part of the CLI's render cache hash, so stale renders are redone.
- The player's worklet is a generated bundle (`packages/player/worklet/bleepkit-worklet.js`, gitignored). Turbo builds it before the studio's dev, build, test and typecheck; run `pnpm --filter @bleepkit/player build:worklet` if you work outside Turbo.
- The studio needs cross-origin isolation (COOP/COEP headers) for shared-memory scopes; the Vite config and the CLI server both send them.
- `ScopeReader.at(channel, frame, frames)` takes the START of the window.
- Looping songs render at least two passes internally and loop the second, so the seam carries the real release tails.
- MP3 adds encoder delay (1105 frames), so MP3 loops are approximate; OGG is the default for game music. Safari games should use synth mode.
- Visual checks of the studio: python3 Playwright with headless Chromium works here (launch with `--autoplay-policy=no-user-gesture-required`).

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
