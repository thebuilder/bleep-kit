// @vitest-environment node
/* The Freesound function (server/freesound): parameters are whitelisted, the upstream URL and the Authorization header
   are what the API docs ask for, only CC0 and CC BY get through, media comes from our origin, and the limits hold.
   No network: Freesound is answered from server/freesound/fixtures.ts. */
import { describe, expect, it } from "vitest";
import {
  createFixtureFetch,
  FIXTURE_KEY,
  FIXTURE_SPECS,
} from "../server/freesound/fixtures.ts";
import {
  type HandlerDeps,
  handleFreesound,
} from "../server/freesound/handler.ts";
import {
  API_BUDGET,
  createLimitState,
  IP_LIMITS,
} from "../server/freesound/limits.ts";
import {
  DEFAULT_QUERY,
  type FreesoundError,
  type FreesoundQuery,
  type SearchResponse,
  type SoundResponse,
} from "../server/freesound/protocol.ts";
import {
  buildFilter,
  buildSearchParams,
  cleanQuery,
  licenseOf,
  mapSound,
  mediaPath,
  parseQuery,
} from "../server/freesound/upstream.ts";

const ENV = { FREESOUND_CLIENT_SECRET: FIXTURE_KEY };
const BASE = "https://studio.example/api/freesound";

function setup(over: HandlerDeps = {}) {
  const fixture = createFixtureFetch();
  const deps: HandlerDeps = {
    env: ENV,
    fetch: fixture.fetch,
    limits: createLimitState(),
    now: () => 1_000_000,
    ...over,
  };
  const get = (path: string, headers: Record<string, string> = {}) =>
    handleFreesound(new Request(`${BASE}/${path}`, { headers }), deps);
  return { calls: fixture.calls, deps, get };
}

const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const query = (over: Partial<FreesoundQuery> = {}): FreesoundQuery => ({
  ...DEFAULT_QUERY,
  ...over,
});

describe("parameters", () => {
  it("accepts the documented shape and sorts the tags", () => {
    const q = parseQuery(
      new URLSearchParams(
        "q=kick&sub=percussion&tags=909,808&license=by&oneshot=1&max=2&sort=shortest&page=3"
      )
    );
    expect(q).toEqual({
      license: "by",
      maxSeconds: 2,
      oneShot: true,
      page: 3,
      q: "kick",
      sort: "shortest",
      sub: "percussion",
      tags: ["808", "909"],
    });
  });

  it("refuses what is not in the whitelist", () => {
    for (const bad of [
      "filter=license:*",
      "sub=nope",
      "sort=created_desc",
      "license=nc",
      "tags=a b",
      "tags=a,b,c,d,e",
      "tags=UPPER",
      "max=3",
      "page=0",
      "page=999",
      "oneshot=0",
      "token=abc",
    ]) {
      expect(typeof parseQuery(new URLSearchParams(bad))).toBe("string");
    }
  });

  it("strips filter syntax out of the free text", () => {
    expect(cleanQuery('kick" license:"Attribution NonCommercial')).toBe(
      "kick license Attribution NonCommercial"
    );
    expect(cleanQuery("a\\b (c) [d] {e} -f")).toBe("a b c d e -f");
    expect(cleanQuery("x".repeat(500))).toHaveLength(80);
  });
});

describe("the upstream request", () => {
  it("builds the filter from the documented field names", () => {
    expect(buildFilter(query())).toBe(
      'category:"Instrument samples" subcategory:"Percussion" license:"Creative Commons 0" duration:[0 TO 20]'
    );
    expect(
      buildFilter(
        query({
          license: "by",
          maxSeconds: 1,
          oneShot: true,
          sort: "rating",
          sub: "keys",
          tags: ["808", "8-bit"],
        })
      )
    ).toBe(
      'category:"Instrument samples" subcategory:"Piano / Keyboard instruments" license:("Creative Commons 0" OR "Attribution") tag:("808" AND "8-bit") duration:[0 TO 1] single_event:true num_ratings:[3 TO *]'
    );
  });

  it("asks for the descriptors by name and pages by 24", () => {
    const p = buildSearchParams(
      query({ page: 2, q: "snare", sort: "downloads" })
    );
    expect(p.get("query")).toBe("snare");
    expect(p.get("sort")).toBe("downloads_desc");
    expect(p.get("page")).toBe("2");
    expect(p.get("page_size")).toBe("24");
    expect(p.get("fields")?.split(",")).toEqual(
      expect.arrayContaining([
        "id",
        "license",
        "previews",
        "images",
        "note_name",
        "single_event",
        "loopable",
        "duration",
      ])
    );
  });

  it("sends the API key as the token and nothing else from the caller", async () => {
    const { calls, get } = setup();
    const res = await get("search?q=kick&sub=percussion", {
      authorization: "Token attacker",
      cookie: "a=b",
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.authorization).toBe(`Token ${FIXTURE_KEY}`);
    const url = new URL(call?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://freesound.org/apiv2/search/"
    );
    expect(url.searchParams.get("filter")).toBe(
      buildFilter(query({ q: "kick" }))
    );
    expect([...url.searchParams.keys()].sort()).toEqual([
      "fields",
      "filter",
      "page",
      "page_size",
      "query",
      "sort",
    ]);
  });
});

describe("licenses", () => {
  it("maps the documented strings and refuses the rest", () => {
    expect(licenseOf("Creative Commons 0")).toBe("cc0");
    expect(licenseOf("Attribution")).toBe("by");
    for (const no of [
      "Attribution NonCommercial",
      "Sampling+",
      "Attribution Noncommercial",
      "",
      null,
      3,
    ]) {
      expect(licenseOf(no)).toBeNull();
    }
    expect(
      mapSound({ id: 1, license: "Attribution NonCommercial", name: "x" })
    ).toBeNull();
  });

  it("never returns a NonCommercial or Sampling+ sound, even when the search lets one through", async () => {
    const { get } = setup();
    const res = await get("search?sub=percussion&license=by");
    const out = await body<SearchResponse>(res);
    expect(out.results.length).toBeGreaterThan(5);
    expect(out.dropped).toBeGreaterThan(0);
    expect(
      out.results.every((s) => s.license === "cc0" || s.license === "by")
    ).toBe(true);
    expect(out.results.map((s) => s.name)).not.toContain(
      "Kick (non commercial)"
    );
    expect(out.results.map((s) => s.name)).not.toContain(
      "Snare (sampling plus)"
    );
  });

  it("defaults to CC0 only", async () => {
    const out = await body<SearchResponse>(
      await setup().get("search?sub=percussion")
    );
    expect(out.results.length).toBeGreaterThan(5);
    expect(out.results.every((s) => s.license === "cc0")).toBe(true);
  });

  it("refuses to describe a sound under another license", async () => {
    const nc = FIXTURE_SPECS.find(
      (s) => s.license === "Attribution NonCommercial"
    );
    const res = await setup().get(`sound/${nc?.id}`);
    expect(res.status).toBe(403);
    expect((await body<FreesoundError>(res)).error).toBe("license-not-allowed");
  });
});

describe("results", () => {
  it("keeps the category, subcategory, tags and length limits", async () => {
    const { get } = setup();
    const kicks = await body<SearchResponse>(
      await get("search?sub=percussion&tags=kick&max=1")
    );
    expect(kicks.results.length).toBeGreaterThan(0);
    expect(
      kicks.results.every((s) => s.tags.includes("kick") && s.duration <= 1)
    ).toBe(true);
    const all = await body<SearchResponse>(await get("search"));
    expect(all.results.map((s) => s.name)).not.toContain("Door slam");
  });

  it("shapes a sound for the studio: descriptors, links and media hints", async () => {
    const out = await body<SearchResponse>(
      await setup().get("search?q=808+kick&sub=percussion")
    );
    const [first] = out.results;
    expect(first).toMatchObject({
      author: expect.any(String),
      license: "cc0",
      note: "F1",
      oneShot: true,
    });
    expect(first?.url.startsWith("https://freesound.org/")).toBe(true);
    expect(first?.pv).toMatch(/^previews\/\d+\/\d+_\d+-hq\.mp3$/);
    expect(first?.wf).toMatch(/^displays\/\d+\/\d+_\d+_wave_M\.png$/);
  });

  it("sorts and pages", async () => {
    const { get } = setup();
    const short = await body<SearchResponse>(
      await get("search?sub=percussion&sort=shortest")
    );
    const lengths = short.results.map((s) => s.duration);
    expect([...lengths].sort((a, b) => a - b)).toEqual(lengths);
    const p1 = await body<SearchResponse>(await get("search?sub=synth"));
    expect(p1.hasMore).toBe(false);
    const wide = await body<SearchResponse>(await get("search?license=by"));
    expect(wide.page).toBe(1);
    expect(wide.hasMore).toBe(true);
    const p2 = await body<SearchResponse>(
      await get("search?license=by&page=2")
    );
    expect(p2.page).toBe(2);
    expect(p2.results[0]?.id).not.toBe(wide.results[0]?.id);
  });

  it("hides a note Freesound is not sure of", () => {
    const base = {
      id: 5,
      license: "Creative Commons 0",
      name: "n",
      note_name: "A4",
    };
    expect(mapSound({ ...base, note_confidence: 0.2 })?.note).toBeNull();
    expect(mapSound({ ...base, note_confidence: 0.8 })?.note).toBe("A4");
    expect(mapSound({ ...base, note_name: "nonsense" })?.note).toBeNull();
  });

  it("falls back when Freesound does not take the one-shot filter", async () => {
    const real = createFixtureFetch();
    const refusing = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url
      );
      if (url.searchParams.get("filter")?.includes("single_event")) {
        return Promise.resolve(
          new Response(JSON.stringify({ detail: "bad filter" }), {
            status: 400,
          })
        );
      }
      return real.fetch(input, init);
    }) as typeof fetch;
    const { get } = setup({ fetch: refusing });
    const out = await body<SearchResponse>(
      await get("search?sub=percussion&oneshot=1")
    );
    expect(out.notes.join(" ")).toContain("one-shot");
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results.every((s) => s.oneShot === true)).toBe(true);
  });
});

describe("not configured and upstream errors", () => {
  it("answers 503 without a key, and status says so", async () => {
    const { get } = setup({ env: {} });
    const res = await get("search");
    expect(res.status).toBe(503);
    expect((await body<FreesoundError>(res)).error).toBe("not-configured");
    expect(await body(await get("status"))).toEqual({ configured: false });
    expect(await body(await setup().get("status"))).toEqual({
      configured: true,
    });
  });

  it("maps a refused key to a plain 502 that does not echo the key", async () => {
    const { get } = setup({ env: { FREESOUND_CLIENT_SECRET: "wrong-key" } });
    const res = await get("search");
    expect(res.status).toBe(502);
    const text = JSON.stringify(await body(res));
    expect(text).toContain("FREESOUND_CLIENT_SECRET");
    expect(text).not.toContain("wrong-key");
  });

  it("passes Freesound's 429 on with a wait time", async () => {
    const throttled = (() =>
      Promise.resolve(
        new Response("{}", { headers: { "retry-after": "42" }, status: 429 })
      )) as typeof fetch;
    const res = await setup({ fetch: throttled }).get("search");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 404 for other paths and refuses other methods", async () => {
    const { deps, get } = setup();
    expect((await get("nothing")).status).toBe(404);
    expect((await get("sound/abc")).status).toBe(400);
    const post = await handleFreesound(
      new Request(`${BASE}/search`, { method: "POST" }),
      deps
    );
    expect(post.status).toBe(400);
  });
});

describe("previews and waveforms", () => {
  const [spec] = FIXTURE_SPECS;
  const hint = (kind: "p" | "w") =>
    kind === "p"
      ? `previews/${Math.floor((spec?.id ?? 0) / 1000)}/${spec?.id}_${5_000_000 + ((spec?.id ?? 0) % 9973)}-hq.mp3`
      : "";

  it("streams the preview from our origin with the right headers, from the hint alone", async () => {
    const { calls, get } = setup();
    const res = await get(
      `preview/${spec?.id}?p=${encodeURIComponent(hint("p"))}`
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toContain("s-maxage=604800");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    // no API call: only the CDN was asked, and without the key
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual([
      "cdn.freesound.org",
    ]);
    expect(calls[0]?.authorization).toBeNull();
  });

  it("looks the sound up when there is no usable hint", async () => {
    for (const p of [
      "",
      "?p=../../etc/passwd",
      "?p=https://evil.example/a.mp3",
      "?p=previews/1/999_1-hq.mp3",
    ]) {
      const { calls, get } = setup();
      const res = await get(`preview/${spec?.id}${p}`);
      expect(res.status).toBe(200);
      const hosts = calls.map((c) => new URL(c.url).hostname);
      expect(hosts).toEqual(["freesound.org", "cdn.freesound.org"]);
      expect(calls[0]?.authorization).toBe(`Token ${FIXTURE_KEY}`);
    }
  });

  it("serves the waveform as an image and refuses extra parameters", async () => {
    const { get } = setup();
    const res = await get(`waveform/${spec?.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]);
    expect((await get(`waveform/${spec?.id}?size=big`)).status).toBe(400);
    expect((await get("preview/99999999")).status).toBe(404);
  });

  it("only takes CDN paths of the right kind for that sound", () => {
    expect(mediaPath("preview", 12, "previews/0/12_3-hq.mp3")).toBe(
      "previews/0/12_3-hq.mp3"
    );
    expect(mediaPath("preview", 12, "previews/0/13_3-hq.mp3")).toBeNull();
    expect(
      mediaPath("preview", 12, "previews/0/12_3-hq.mp3/../../x")
    ).toBeNull();
    expect(mediaPath("preview", 12, "displays/0/12_3_wave_M.png")).toBeNull();
    expect(mediaPath("waveform", 12, "displays/0/12_3_wave_M.png")).toBe(
      "displays/0/12_3_wave_M.png"
    );
    expect(mediaPath("preview", 12, null)).toBeNull();
  });
});

describe("limits", () => {
  it("stops one visitor after the per-minute search limit, but not another", async () => {
    const { get } = setup();
    const mine = { "x-forwarded-for": "203.0.113.7" };
    for (let i = 0; i < IP_LIMITS.search; i += 1) {
      expect((await get(`search?q=a${i}`, mine)).status).toBe(200);
    }
    const over = await get("search?q=more", mine);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(
      (await get("search?q=other", { "x-forwarded-for": "198.51.100.1" }))
        .status
    ).toBe(200);
  });

  it("forgets a visitor after a minute", async () => {
    let now = 1_000_000;
    const { get } = setup({ now: () => now });
    const mine = { "x-forwarded-for": "203.0.113.9" };
    for (let i = 0; i < IP_LIMITS.search; i += 1) {
      await get(`search?q=a${i}`, mine);
    }
    expect((await get("search?q=x", mine)).status).toBe(429);
    now += 61_000;
    expect((await get("search?q=x", mine)).status).toBe(200);
  });

  it("keeps this instance under Freesound's own limit across visitors", async () => {
    const { calls, get } = setup();
    let refused = 0;
    for (let i = 0; i < API_BUDGET.perMinute + 5; i += 1) {
      const res = await get(`search?q=q${i}`, {
        "x-forwarded-for": `10.0.0.${i}`,
      });
      refused += res.status === 429 ? 1 : 0;
    }
    expect(calls.length).toBe(API_BUDGET.perMinute);
    expect(refused).toBe(5);
  });

  it("does not spend API calls on media with a hint", async () => {
    const { calls, get } = setup();
    const [, spec] = FIXTURE_SPECS;
    const p = `previews/${Math.floor((spec?.id ?? 0) / 1000)}/${spec?.id}_${5_000_000 + ((spec?.id ?? 0) % 9973)}-hq.mp3`;
    for (let i = 0; i < 30; i += 1) {
      expect(
        (await get(`preview/${spec?.id}?p=${encodeURIComponent(p)}`)).status
      ).toBe(200);
    }
    expect(calls.every((c) => c.authorization === null)).toBe(true);
  });
});

describe("caching", () => {
  it("lets a shared cache keep searches, sounds and media, and never errors", async () => {
    const { get } = setup();
    const search = await get("search");
    expect(search.headers.get("cache-control")).toBe(
      "public, max-age=60, s-maxage=600, stale-while-revalidate=3600"
    );
    const [spec] = FIXTURE_SPECS;
    const sound = await get(`sound/${spec?.id}`);
    expect(sound.headers.get("cache-control")).toContain("s-maxage=3600");
    expect((await body<SoundResponse>(sound)).sound.id).toBe(spec?.id);
    const bad = await get("search?sub=zzz");
    expect(bad.status).toBe(400);
    expect(bad.headers.get("cache-control")).toBe("no-store");
  });
});
