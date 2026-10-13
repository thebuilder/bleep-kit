/* Sample attribution (architecture.md section 2.10): the `source` of a Freesound sample survives normalize, bad ones
   are dropped with a warning, and CREDITS.txt lists the CC BY samples only. */

import { describe, expect, it } from "vitest";
import type { SampleSource, UserSample } from "../src/index.ts";
import {
  CREDITS_HEADER,
  creditedSources,
  creditsText,
  normalizeSample,
  sampleFromData,
} from "../src/index.ts";

const source = (over: Partial<SampleSource> = {}): SampleSource => ({
  author: "somebody",
  id: 1234,
  kind: "freesound",
  license: "CC BY",
  name: "Kick 808",
  url: "https://freesound.org/people/somebody/sounds/1234/",
  ...over,
});

const withSource = (s: SampleSource | undefined): UserSample => ({
  ...sampleFromData(new Float32Array(64), 8000),
  ...(s ? { source: s } : {}),
});

describe("normalizeSample source", () => {
  it("keeps a well formed source", () => {
    const out = normalizeSample(withSource(source()));
    expect(out.ok).toBe(true);
    expect(out.value.source).toEqual(source());
  });

  it("drops a malformed source with a warning and keeps the audio", () => {
    for (const bad of [
      { ...source(), license: "CC BY-NC" },
      { ...source(), url: "http://freesound.org/s/1/" },
      { ...source(), id: 0 },
      { ...source(), kind: "other" },
      "freesound",
    ]) {
      const out = normalizeSample({ ...withSource(undefined), source: bad });
      expect(out.ok).toBe(true);
      expect(out.value.source).toBeUndefined();
      expect(out.issues.some((i) => i.path === "/source")).toBe(true);
    }
  });

  it("has no source when none was given", () => {
    expect(normalizeSample(withSource(undefined)).value.source).toBeUndefined();
  });
});

describe("creditsText", () => {
  it("lists CC BY samples once each and skips CC0", () => {
    const samples = {
      a: withSource(source()),
      b: withSource(source({ id: 77, license: "CC0", name: "Snare" })),
      c: withSource(source()),
      d: withSource(source({ author: "zed", id: 5, name: "Alpha pad" })),
      e: withSource(undefined),
    };
    expect(creditedSources(samples).map((s) => s.id)).toEqual([5, 1234]);
    const text = creditsText(samples) ?? "";
    expect(text.startsWith(CREDITS_HEADER)).toBe(true);
    expect(text).toContain('"Kick 808" by somebody');
    expect(text).toContain('"Alpha pad" by zed');
    expect(text).toContain(
      "https://freesound.org/people/somebody/sounds/1234/"
    );
    expect(text).not.toContain("Snare");
    expect(text.split("Kick 808")).toHaveLength(2);
  });

  it("is null when nothing needs a credit", () => {
    expect(creditsText({})).toBeNull();
    expect(
      creditsText({
        a: withSource(source({ license: "CC0" })),
        b: withSource(undefined),
      })
    ).toBeNull();
  });
});
