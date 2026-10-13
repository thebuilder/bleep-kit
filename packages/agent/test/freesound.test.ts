import { describe, expect, it } from "vitest";
import {
  type AgentTool,
  createTools,
  type FreesoundHit,
  type FreesoundHost,
  type FreesoundSearchOptions,
} from "../src/index.ts";
import { seededHost } from "./fake-host.ts";

const KICK: FreesoundHit = {
  author: "tester",
  id: 101,
  license: "CC0",
  name: "Soft kick",
  note: "A1",
  oneShot: true,
  seconds: 0.4,
  subcategory: "Percussion",
  tags: ["kick", "808"],
};
const BLOCK: FreesoundHit = {
  ...KICK,
  id: 102,
  license: "CC BY",
  name: "Wood block",
  note: null,
};

function setup(withFreesound = true) {
  const host = seededHost();
  const searches: FreesoundSearchOptions[] = [];
  const imports: [number, string | null][] = [];
  const freesound: FreesoundHost = {
    import: (id, opts) => {
      imports.push([id, opts.instrument]);
      const hit = [KICK, BLOCK].find((h) => h.id === id);
      if (!hit) {
        return Promise.reject(
          new Error(`Freesound sound ${id} was not in a search result`)
        );
      }
      return Promise.resolve({
        hit,
        instrument: opts.instrument,
        sample: {
          baseNote: 33,
          bits: 8,
          bytes: 100,
          finetune: 0,
          frames: 1000,
          id: "soft-kick",
          loop: null,
          name: hit.name,
          rate: 11_025,
          seconds: 0.4,
          volume: 1,
        },
      });
    },
    search: (opts) => {
      searches.push(opts);
      return Promise.resolve({
        count: 2,
        hasMore: false,
        hits: opts.query === "nothing" ? [] : [KICK, BLOCK],
        notes: [],
      });
    },
  };
  if (withFreesound) {
    host.freesound = freesound;
  }
  const tools = createTools(host);
  const call = (name: string, input: unknown) => {
    const tool = tools.find((t: AgentTool) => t.spec.name === name);
    if (!tool) {
      throw new Error(`no tool ${name}`);
    }
    return tool.run(input);
  };
  return { call, imports, searches, tools };
}

describe("freesound tools", () => {
  it("are left out of a host without a Freesound browser", () => {
    const names = setup(false).tools.map((t) => t.spec.name);
    expect(names).not.toContain("search_freesound");
    expect(names).not.toContain("import_freesound_sample");
    expect(setup().tools.map((t) => t.spec.name)).toContain("search_freesound");
  });

  it("searches with the options the model gave, and lists id, license, length and note", async () => {
    const { call, searches } = setup();
    const out = await call("search_freesound", {
      license: "by",
      max_seconds: 1,
      one_shot: true,
      query: "kick",
      subcategory: "percussion",
      tags: ["808"],
    });
    expect(searches).toEqual([
      {
        license: "by",
        maxSeconds: 1,
        oneShot: true,
        query: "kick",
        subcategory: "percussion",
        tags: ["808"],
      },
    ]);
    expect(out.isError).toBeUndefined();
    expect(out.text).toContain(
      '101: "Soft kick" by tester (0.4 s, one-shot, note A1, CC0) [kick, 808]'
    );
    expect(out.text).toContain("102:");
    expect(out.text).toContain("no clear note, CC BY");
  });

  it("refuses options outside the whitelist and says what to fix", async () => {
    const { call, searches } = setup();
    const bads = [
      { license: "by-nc" },
      { subcategory: "drums" },
      { max_seconds: 30 },
      { tags: ["a", "b", "c", "d", "e"] },
      { sort: "newest" },
    ];
    const outs = await Promise.all(
      bads.map((bad) => call("search_freesound", bad))
    );
    expect(outs.map((o) => o.isError)).toEqual(bads.map(() => true));
    expect(searches).toEqual([]);
  });

  it("says so when nothing matched", async () => {
    const out = await setup().call("search_freesound", { query: "nothing" });
    expect(out.summary).toBe("No Freesound results");
  });

  it("imports a sound and tells the model whether it needs credit", async () => {
    const { call, imports } = setup();
    const cc0 = await call("import_freesound_sample", { id: 101 });
    expect(cc0.text).toContain("CC0: no credit is needed");
    expect(cc0.text).toContain("set_instrument_sample");
    const by = await call("import_freesound_sample", {
      id: 102,
      instrument: "wood-block",
    });
    expect(by.text).toContain("CC BY");
    expect(by.text).toContain("CREDITS.txt");
    expect(by.text).toContain("instrument/wood-block");
    expect(imports).toEqual([
      [101, null],
      [102, "wood-block"],
    ]);
  });

  it("refuses a bad instrument id, an instrument that exists and an unknown sound", async () => {
    const { call, imports } = setup();
    expect(
      (await call("import_freesound_sample", { id: 101, instrument: "Bad Id" }))
        .isError
    ).toBe(true);
    const existing = await call("import_freesound_sample", {
      id: 101,
      instrument: "lead",
    });
    expect(existing.isError).toBe(true);
    expect(existing.text).toContain("already an instrument");
    const unknown = await call("import_freesound_sample", { id: 999 });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("was not in a search result");
    expect(imports).toEqual([[999, null]]);
  });
});
