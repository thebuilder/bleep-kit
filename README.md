# Bleepkit

Generates retro 80s and 90s game audio: sound effects and music, from code, in the browser and on the command line.

## Commands

```sh
pnpm install          # install dependencies
pnpm dev              # run the studio with hot reload
pnpm build            # build every package and the studio
pnpm preview          # serve the built studio
pnpm bleepkit <args>  # run the CLI from the workspace sources
pnpm typecheck        # type-check every package (Turbo)
pnpm check            # lint and formatting (Ultracite)
pnpm fix              # fix lint and formatting
pnpm test             # run the tests (Turbo)
pnpm test:coverage    # run the tests with coverage
pnpm test:watch       # run the tests in watch mode
pnpm fallow           # test with coverage, then run Fallow
pnpm check:packages   # pack the packages and use the tarballs in a scratch project
pnpm verify           # everything CI runs
```
