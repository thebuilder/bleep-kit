/* The assistant's Freesound tools over the studio: a search goes through the same routes as the panel, and only a sound
   a search returned in this session can be imported. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_KEY } from "../server/freesound/fixtures.ts";
import { createFreesoundHost } from "../src/assistant/freesound-host.ts";
import { clearSearchCache } from "../src/freesound/api.ts";
import type { UserSample } from "../src/lib/contract.ts";
import { project } from "../src/state/docs.ts";
import { LocalStore, memoryBackend } from "../src/store/local.ts";
import { ORIGIN, serve } from "./freesound-helpers.ts";

/* The browser's decoder is not here; the preview's bytes become a short tone. */
vi.mock("../src/lib/audio-decode.ts", () => ({
  AUDIO_ACCEPT: "audio/*",
  decodeAudioBytes: () =>
    Promise.resolve({
      channels: [
        Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i / 9)),
      ],
      sampleRate: 22_050,
    }),
}));

const info = (id: string, s: UserSample) => ({
  baseNote: s.baseNote,
  bits: s.bits,
  bytes: 0,
  finetune: s.finetune,
  frames: 0,
  id,
  loop: null,
  name: s.name,
  rate: s.rate,
  seconds: 0,
  volume: s.volume,
});

beforeEach(async () => {
  clearSearchCache();
  project.setAutosave(false);
  await project.load(new LocalStore(memoryBackend()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the assistant's Freesound host", () => {
  it("searches CC0 by default, with the options asked for, and never returns other licenses", async () => {
    const asked = serve({ FREESOUND_CLIENT_SECRET: FIXTURE_KEY });
    const host = createFreesoundHost(info);
    const out = await host.search({
      maxSeconds: 3,
      oneShot: true,
      query: "kick",
      subcategory: "percussion",
      tags: ["808"],
    });
    const params = new URL(asked[0] as string, ORIGIN).searchParams;
    expect(params.get("q")).toBe("kick");
    expect(params.get("sub")).toBe("percussion");
    expect(params.get("max")).toBe("5");
    expect(params.get("oneshot")).toBe("1");
    expect(params.get("license")).toBeNull();
    expect(out.hits.length).toBeGreaterThan(0);
    expect(new Set(out.hits.map((h) => h.license))).toEqual(new Set(["CC0"]));
    const both = await host.search({ license: "by" });
    expect(new Set(both.hits.map((h) => h.license))).toEqual(
      new Set(["CC0", "CC BY"])
    );
  });

  it("imports a sound it showed, with its source and an instrument, and refuses one it did not", async () => {
    serve({ FREESOUND_CLIENT_SECRET: FIXTURE_KEY });
    const host = createFreesoundHost(info);
    await expect(
      host.import(123_456_789, { instrument: null })
    ).rejects.toThrow(/not in a search result/);
    const { hits } = await host.search({ license: "by" });
    const hit = hits.find((h) => h.license === "CC BY");
    expect(hit).toBeDefined();
    const got = await host.import(hit?.id as number, {
      instrument: "from-freesound",
    });
    expect(got.instrument).toBe("from-freesound");
    expect(project.samples()[got.sample.id]?.source).toMatchObject({
      id: hit?.id,
      license: "CC BY",
    });
    expect(project.get("instrument", "from-freesound")).toBeDefined();
  });

  it("passes the service's failure on in words", async () => {
    serve({});
    await expect(createFreesoundHost(info).search({})).rejects.toThrow(
      /key|set up|configured/i
    );
  });
});
