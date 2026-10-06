/* The typed manifest (architecture section 7): ids from the game's audio.ts become the only ids the player accepts.
   The assertions are compile-time: vitest runs this file but only `tsc -p .` (pnpm typecheck, part of pnpm verify)
   fails when the generic typing regresses, through the expectTypeOf mismatches and the @ts-expect-error lines that
   would turn into unused directives. */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AudioManifest,
  type BleepPlayer,
  createPlayer,
} from "../src/index.ts";
import { FakeContext } from "./fake-audio.ts";

const manifest = {
  base: "/audio/",
  sampleRate: 48_000,
  sfx: {
    coin: { duration: 0.31, file: "coin.ogg" },
    laser: { duration: 0.42, file: "laser.ogg" },
  },
  songs: {
    title: {
      duration: 25,
      events: "title.events.json",
      file: "title.ogg",
      loopEnd: 24,
      loopStart: 4.8,
    },
  },
} as const satisfies AudioManifest;

const options = {
  context: new FakeContext().asContext(),
  onError: () => undefined,
  unlockOnGesture: false,
};

describe("typed ids", () => {
  it("restricts sfx and music ids to the manifest's keys", async () => {
    const player = await createPlayer({ ...options, manifest });
    expectTypeOf(player).toEqualTypeOf<
      BleepPlayer<"coin" | "laser", "title">
    >();
    expectTypeOf(player.sfx).parameter(0).toEqualTypeOf<"coin" | "laser">();
    expectTypeOf(player.music).parameter(0).toEqualTypeOf<"title">();
    expectTypeOf(player.preload)
      .parameter(0)
      .toEqualTypeOf<("coin" | "laser" | "title")[] | undefined>();
  });

  it("rejects an id the manifest does not have, and an id of the other kind", () => {
    // never called: these lines only have to compile, and each directive fails typecheck if its line stops erroring
    const wrongIds = async () => {
      const player = await createPlayer({ ...options, manifest });
      // @ts-expect-error "boom" is not a sound in this manifest
      player.sfx("boom");
      // @ts-expect-error a song id is not an sfx id
      player.sfx("title");
      // @ts-expect-error an sfx id is not a song id
      await player.music("coin");
    };
    expect(wrongIds).toBeTypeOf("function");
  });

  it("has no valid song id for a manifest without songs", async () => {
    const sfxOnly = {
      base: "/audio/",
      sampleRate: 48_000,
      sfx: { coin: { duration: 0.31, file: "coin.ogg" } },
      songs: {},
    } as const satisfies AudioManifest;
    const player = await createPlayer({ ...options, manifest: sfxOnly });
    expectTypeOf(player.sfx).parameter(0).toEqualTypeOf<"coin">();
    expectTypeOf(player.music).parameter(0).toEqualTypeOf<never>();
  });

  it("accepts any string for a manifest typed as the plain AudioManifest", async () => {
    const plain: AudioManifest = manifest;
    const player = await createPlayer({ ...options, manifest: plain });
    expectTypeOf(player).toEqualTypeOf<BleepPlayer<string, string>>();
    expect(() => player.sfx("anything")).not.toThrow();
  });

  it("lets a loosely typed player be narrowed by annotation (method parameters are bivariant)", async () => {
    const plain: AudioManifest = manifest;
    const player: BleepPlayer<"coin" | "laser", "title"> = await createPlayer({
      ...options,
      manifest: plain,
    });
    expectTypeOf(player.sfx).parameter(0).toEqualTypeOf<"coin" | "laser">();
  });

  it("is the string player without a manifest", async () => {
    const player = await createPlayer(options);
    expectTypeOf(player).toEqualTypeOf<BleepPlayer<string, string>>();
  });
});
