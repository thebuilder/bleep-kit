import { afterEach, describe, expect, it, vi } from "vitest";
import {
  joinUrl,
  loadManifest,
  parseManifest,
  supportsOgg,
  undecodableFiles,
} from "../src/manifest.ts";
import { fakeFetch } from "./fake-audio.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = {
  base: "/audio/",
  sampleRate: 44_100,
  sfx: { coin: { duration: 0.3, file: "coin.ogg" } },
  songs: {
    title: {
      duration: 25,
      events: "title.events.json",
      file: "title.ogg",
      loopEnd: 24,
      loopStart: 4.8,
    },
  },
};

describe("supportsOgg", () => {
  it("asks canPlayType for Vorbis in Ogg", () => {
    const asked: string[] = [];
    const probe = (answer: string) => ({
      canPlayType: (type: string) => {
        asked.push(type);
        return answer;
      },
    });
    expect(supportsOgg(probe("probably"))).toBe(true);
    expect(supportsOgg(probe("maybe"))).toBe(true);
    expect(supportsOgg(probe(""))).toBe(false);
    expect(asked[0]).toBe('audio/ogg; codecs="vorbis"');
  });

  it("uses the page's audio element by default and assumes yes when it cannot ask", () => {
    vi.stubGlobal(
      "Audio",
      class {
        canPlayType() {
          return "";
        }
      }
    );
    expect(supportsOgg()).toBe(false);
    vi.stubGlobal(
      "Audio",
      class {
        canPlayType() {
          throw new Error("no audio");
        }
      }
    );
    expect(supportsOgg()).toBe(true);
  });
});

describe("joinUrl", () => {
  it("joins a base and a file with exactly one slash", () => {
    expect(joinUrl("/audio/", "a.ogg")).toBe("/audio/a.ogg");
    expect(joinUrl("/audio", "a.ogg")).toBe("/audio/a.ogg");
    expect(joinUrl("", "a.ogg")).toBe("a.ogg");
    expect(joinUrl("https://cdn.example.com/x/", "a.ogg")).toBe(
      "https://cdn.example.com/x/a.ogg"
    );
  });
});

describe("parseManifest", () => {
  it("keeps an absolute base and fills the sample rate", () => {
    expect(parseManifest(json, "/audio/manifest.json")).toEqual(json);
    expect(
      parseManifest({ ...json, sampleRate: undefined }, "/m.json").sampleRate
    ).toBe(48_000);
  });

  it("resolves a relative base against the manifest's own URL", () => {
    const url = "https://cdn.example.com/game/audio/manifest.json";
    expect(parseManifest({ ...json, base: "./" }, url).base).toBe(
      "https://cdn.example.com/game/audio/"
    );
    expect(parseManifest({ ...json, base: "" }, url).base).toBe(
      "https://cdn.example.com/game/audio/"
    );
    expect(parseManifest({ ...json, base: "../sounds/" }, url).base).toBe(
      "https://cdn.example.com/game/sounds/"
    );
    expect(
      parseManifest({ ...json, base: "https://other.example.com/a/" }, url).base
    ).toBe("https://other.example.com/a/");
  });

  it("resolves a relative base against the page when the manifest URL is relative too", () => {
    vi.stubGlobal("location", {
      href: "https://game.example.com/play/index.html",
    });
    expect(
      parseManifest({ ...json, base: "./" }, "audio/manifest.json").base
    ).toBe("https://game.example.com/play/audio/");
    expect(
      parseManifest({ ...json, base: "" }, "/audio/manifest.json").base
    ).toBe("https://game.example.com/audio/");
  });

  it("rejects a manifest that is not one", () => {
    expect(() => parseManifest(null, "/m.json")).toThrow("not a JSON object");
    expect(() => parseManifest("manifest", "/m.json")).toThrow(
      "not a JSON object"
    );
    expect(() => parseManifest({ sfx: { a: {} } }, "/m.json")).toThrow(
      'sfx "a" has no file'
    );
    expect(() => parseManifest({ songs: { b: null } }, "/m.json")).toThrow(
      'song "b" has no file'
    );
  });

  it("accepts a manifest with no sounds", () => {
    expect(parseManifest({}, "/m.json")).toEqual({
      base: "/",
      sampleRate: 48_000,
      sfx: {},
      songs: {},
    });
  });
});

describe("undecodableFiles", () => {
  const manifest = parseManifest(
    {
      ...json,
      sfx: {
        ...json.sfx,
        mp3: { duration: 1, file: "x.mp3" },
        shout: { duration: 1, file: "Shout.OGG" },
        synth: { data: {}, duration: 1, file: "s.ogg" },
      },
    },
    "/m.json"
  );
  it("lists OGG files a browser without OGG cannot decode, except embedded ones", () => {
    expect(undecodableFiles(manifest, false)).toEqual([
      "coin.ogg",
      "Shout.OGG",
      "title.ogg",
    ]);
    expect(undecodableFiles(manifest, true)).toEqual([]);
  });
});

describe("loadManifest", () => {
  it("fetches and parses manifest.json", async () => {
    vi.stubGlobal("fetch", fakeFetch({ "/audio/manifest.json": json }).fn);
    vi.stubGlobal(
      "Audio",
      class {
        canPlayType() {
          return "maybe";
        }
      }
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await loadManifest("/audio/manifest.json")).toEqual(json);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once when the browser cannot decode the OGG files it lists", async () => {
    vi.stubGlobal("fetch", fakeFetch({ "/audio/manifest.json": json }).fn);
    vi.stubGlobal(
      "Audio",
      class {
        canPlayType() {
          return "";
        }
      }
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await loadManifest("/audio/manifest.json");
    expect(warn).toHaveBeenCalledTimes(1);
    // says who is affected, what to do about it and how many files are lost (coin.ogg and title.ogg)
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("Safari");
    expect(message).toContain("embed: true");
    expect(message).toContain("(2 files)");
  });

  it("explains a failed download", async () => {
    vi.stubGlobal("fetch", fakeFetch({}).fn);
    await expect(loadManifest("/audio/manifest.json")).rejects.toThrow(
      "could not load the manifest /audio/manifest.json: 404 Not Found"
    );
  });
});
