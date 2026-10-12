import type { Instrument, Sfx, Song } from "@bleepkit/core";
import { makeInstrument, normalizeSong } from "@bleepkit/core";
import { describe, expect, it } from "vitest";
import { type AgentTool, createTools, MAX_TOOL_TEXT } from "../src/index.ts";
import { analysisOf, seededHost, seedSong } from "./fake-host.ts";

function setup() {
  const host = seededHost();
  const tools = createTools(host);
  const call = (name: string, input: unknown) => {
    const tool = tools.find((t: AgentTool) => t.spec.name === name);
    if (!tool) {
      throw new Error(`no tool ${name}`);
    }
    return tool.run(input);
  };
  return { call, host, tools };
}

describe("tool definitions", () => {
  it("have unique names, descriptions and object schemas, and no em dash anywhere", () => {
    const { tools } = setup();
    const names = tools.map((t) => t.spec.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools) {
      expect(t.spec.name).toMatch(/^[a-z_]{3,40}$/);
      expect(t.spec.description.length).toBeGreaterThan(20);
      expect(t.spec.inputSchema.type).toBe("object");
      expect(JSON.stringify(t.spec)).not.toContain("\u2014");
    }
  });

  it("leaves view_analysis out for a model that cannot look at pictures", () => {
    const names = createTools(seededHost(), { images: false }).map(
      (t) => t.spec.name
    );
    expect(names).not.toContain("view_analysis");
    expect(names).toContain("render_analyze");
  });
});

describe("input validation", () => {
  it("says exactly what is wrong and does nothing", async () => {
    const { call, host } = setup();
    const out = await call("new_sfx", { category: "banana", id: "Bad Id" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("category: must be one of");
    expect(out.text).toContain("id: must match");
    expect(host.calls).toEqual([]);
  });

  it("names a missing required field", async () => {
    const { call } = setup();
    const out = await call("read_document", {});
    expect(out.text).toContain("ref: is required");
  });

  it("refuses a bare id or a plural kind with the right form", async () => {
    const { call } = setup();
    expect((await call("read_document", { ref: "coin" })).text).toContain(
      'like "sfx/coin"'
    );
    expect((await call("read_document", { ref: "songs/tune" })).text).toContain(
      "song/tune"
    );
  });
});

describe("list and read", () => {
  it("lists the project and its documents", async () => {
    const { call } = setup();
    const out = await call("list_documents", {});
    expect(out.text).toContain('Project "Test": chip nes');
    expect(out.text).toContain("sfx/coin");
    expect(out.text).toContain("instrument/lead");
  });

  it("reads a document with a description and cuts long JSON", async () => {
    const { call } = setup();
    const out = await call("read_document", { ref: "sfx/coin" });
    expect(out.isError).toBeUndefined();
    expect(out.text).toContain('"envelope"');
    const part = await call("read_document", {
      path: "/envelope",
      ref: "sfx/coin",
    });
    expect(part.text).toContain("JSON at /envelope");
    expect(part.text).toContain('"decay"');
    const bad = await call("read_document", {
      path: "/nope/deeper",
      ref: "sfx/coin",
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("nothing at /nope");
  });

  it("says when there is no such document", async () => {
    const { call } = setup();
    const out = await call("read_document", { ref: "sfx/ghost" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("list_documents");
  });
});

describe("writing", () => {
  it("applies a valid document and reports clamped values", async () => {
    const { call, host } = setup();
    const doc = {
      ...(host.docs.get("sfx/coin") as Sfx),
      name: "Big coin",
      volume: 3,
    };
    const out = await call("write_document", {
      json: doc,
      ref: "sfx/coin-big",
    });
    expect(out.isError).toBeUndefined();
    expect(out.summary).toBe("Created sfx/coin-big");
    expect(out.text).toContain("adjusted");
    expect((host.docs.get("sfx/coin-big") as Sfx).volume).toBe(1);
  });

  it("accepts the document as a JSON string", async () => {
    const { call, host } = setup();
    const doc = host.docs.get("sfx/coin");
    const out = await call("write_document", {
      json: JSON.stringify(doc),
      ref: "sfx/copy",
    });
    expect(out.isError).toBeUndefined();
    expect(host.docs.has("sfx/copy")).toBe(true);
  });

  it("refuses an invalid document, lists the issues and saves nothing", async () => {
    const { call, host } = setup();
    const before = host.calls.length;
    const out = await call("write_document", {
      json: { version: 1, volume: "loud", wave: 7 },
      ref: "sfx/broken",
    });
    expect(out.isError).toBe(true);
    expect(out.summary).toMatch(/^Refused sfx\/broken: \d+ errors?$/);
    expect(out.text).toContain("error /");
    expect(out.text).toContain("nothing was saved");
    expect(host.docs.has("sfx/broken")).toBe(false);
    expect(host.calls.slice(before)).toEqual([]);
  });

  it("refuses a song that points at an instrument that does not exist", async () => {
    const { call, host } = setup();
    const out = await call("write_document", {
      json: {
        channels: [{ id: "pulse1", instrument: "ghost", kind: "pulse" }],
        chip: "nes",
        name: "x",
        version: 1,
      },
      ref: "song/x",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("ghost");
    expect(host.docs.has("song/x")).toBe(false);
  });
});

describe("edit_document", () => {
  it("edits by JSON pointer and keeps the rest", async () => {
    const { call, host } = setup();
    const out = await call("edit_document", {
      changes: [
        { path: "/envelope/decay", value: 0.5 },
        { path: "/name", value: "Renamed" },
      ],
      ref: "sfx/coin",
    });
    expect(out.isError).toBeUndefined();
    expect(out.summary).toBe("Edited sfx/coin (2 changes)");
    const sfx = host.docs.get("sfx/coin") as Sfx;
    expect(sfx.envelope.decay).toBe(0.5);
    expect(sfx.name).toBe("Renamed");
    expect(sfx.category).toBe("coin");
  });

  it("edits one channel of a song and removes another", async () => {
    const { call, host } = setup();
    seedSong(host);
    const out = await call("edit_document", {
      changes: [
        { path: "/channels/1/mml", value: "o1 l8 c c g g" },
        { op: "remove", path: "/channels/0/mml" },
      ],
      ref: "song/tune",
    });
    expect(out.isError).toBeUndefined();
    const song = host.docs.get("song/tune") as Song;
    expect(song.channels[1]?.mml).toBe("o1 l8 c c g g");
    expect(song.channels[0]?.mml).toBeNull();
  });

  it("names the bad change and leaves the document alone", async () => {
    const { call, host } = setup();
    seedSong(host);
    const before = JSON.stringify(host.docs.get("song/tune"));
    const out = await call("edit_document", {
      changes: [{ path: "/channels/9/mml", value: "c" }],
      ref: "song/tune",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("change 1");
    expect(out.text).toContain("nothing at /channels/9");
    expect(JSON.stringify(host.docs.get("song/tune"))).toBe(before);
  });

  it("refuses an edit that would make the document invalid", async () => {
    const { call, host } = setup();
    const before = JSON.stringify(host.docs.get("sfx/coin"));
    const out = await call("edit_document", {
      changes: [{ path: "/wave", value: "banana" }],
      ref: "sfx/coin",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("/wave");
    expect(JSON.stringify(host.docs.get("sfx/coin"))).toBe(before);
  });

  it("asks for a value when a set has none", async () => {
    const { call } = setup();
    const out = await call("edit_document", {
      changes: [{ path: "/name" }],
      ref: "sfx/coin",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('no "value"');
  });
});

describe("creating", () => {
  it("generates an sfx deterministically and refuses to overwrite", async () => {
    const a = setup();
    const b = setup();
    const x = await a.call("new_sfx", { category: "jump", id: "hop" });
    const y = await b.call("new_sfx", { category: "jump", id: "hop" });
    expect(x.summary).toBe("Created sfx/hop (nes jump)");
    expect(JSON.stringify(a.host.docs.get("sfx/hop"))).toBe(
      JSON.stringify(b.host.docs.get("sfx/hop"))
    );
    expect(y.isError).toBeUndefined();
    const again = await a.call("new_sfx", { category: "jump", id: "hop" });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("already exists");
    const replaced = await a.call("new_sfx", {
      category: "laser",
      id: "hop",
      replace: true,
    });
    expect(replaced.isError).toBeUndefined();
    expect((a.host.docs.get("sfx/hop") as Sfx).category).toBe("laser");
  });

  it("mutates into new ids and leaves the original", async () => {
    const { call, host } = setup();
    const before = JSON.stringify(host.docs.get("sfx/coin"));
    const out = await call("mutate_sfx", { count: 2, ref: "sfx/coin" });
    expect(out.isError).toBe(false);
    expect(host.docs.has("sfx/coin-m1")).toBe(true);
    expect(host.docs.has("sfx/coin-m2")).toBe(true);
    expect(JSON.stringify(host.docs.get("sfx/coin"))).toBe(before);
    const more = await call("mutate_sfx", { ref: "sfx/coin" });
    expect(more.summary).toContain("coin-m3");
    expect((await call("mutate_sfx", { ref: "song/tune" })).isError).toBe(true);
  });

  it("creates a song from MML with matching instruments", async () => {
    const { call, host } = setup();
    const out = await call("new_song", {
      id: "town",
      mml: { pulse1: "t120 o4 l8 [cdef]2 L", triangle: "o2 l4 c g" },
      tempo: 120,
    });
    expect(out.isError).toBeUndefined();
    const song = host.docs.get("song/town") as Song;
    expect(song.channels.find((c) => c.id === "pulse1")?.instrument).toBe(
      "lead"
    );
    expect(song.channels.find((c) => c.id === "triangle")?.instrument).toBe(
      "bass"
    );
    expect(out.text).toContain("render_analyze song/town");
  });

  it("reports MML errors and unknown channels before saving", async () => {
    const { call, host } = setup();
    const out = await call("new_song", {
      id: "bad",
      mml: { pulse1: "o4 cdexyz", violin: "c" },
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      'mml.violin: the nes chip has no channel "violin"'
    );
    expect(out.text).toContain("mml.pulse1:");
    expect(host.docs.has("song/bad")).toBe(false);
  });

  it("makes instruments from the presets for a song in an empty project", async () => {
    const { call, host } = setup();
    for (const k of [...host.docs.keys()]) {
      if (k.startsWith("instrument/")) {
        host.docs.delete(k);
      }
    }
    const out = await call("new_song", {
      id: "empty",
      mml: { pulse1: "o4 c" },
    });
    expect(out.isError).toBeUndefined();
    const song = host.docs.get("song/empty") as Song;
    expect(song.channels.find((c) => c.id === "pulse1")?.instrument).toBe(
      "nes-lead"
    );
    expect((host.docs.get("instrument/nes-lead") as Instrument).chip).toBe(
      "nes"
    );
    expect(out.text).toContain("instrument/nes-lead");
    // the channels with nothing to play got nothing
    expect(song.channels.filter((c) => c.instrument !== null)).toHaveLength(1);
  });

  describe("a genesis song in a project of NES instruments", () => {
    const MEGA = {
      fm1: "o2 l8 c c c c",
      fm2: "o4 l8 c e g e",
      fm3: "o5 l4 c e g e",
      fm4: "o4 l2 c e",
      psg1: "o5 l8 e g a g",
      psgNoise: "o3 l8 c r c r",
    };

    it("gives the channels that play notes instruments made for the genesis, and leaves the others empty", async () => {
      const { call, host } = setup();
      const out = await call("new_song", {
        chip: "genesis",
        id: "mega",
        mml: MEGA,
      });
      expect(out.isError).toBeUndefined();
      const song = host.docs.get("song/mega") as Song;
      const insts = await host.instruments();
      const byChannel = Object.fromEntries(
        song.channels.map((c) => [c.id, c.instrument])
      );
      for (const id of ["fm5", "fm6", "psg2", "psg3"]) {
        expect(byChannel[id], id).toBeNull();
      }
      for (const id of Object.keys(MEGA)) {
        const inst = insts[byChannel[id] ?? ""];
        expect(inst, id).toBeDefined();
        expect(inst?.chip, id).toBe("genesis");
        expect(inst?.kind, id).toBe(
          song.channels.find((c) => c.id === id)?.kind
        );
      }
      // no copy of the bass on every voice: the bass channel and the melodic ones differ
      expect(byChannel.fm1).not.toBe(byChannel.fm2);
      expect(normalizeSong(song, insts).issues).toEqual([]);
      expect(out.text).toContain("Made instrument/");
    });

    it("refuses an instrument made for another chip, and lists the ones that fit", async () => {
      const { call, host } = setup();
      host.docs.set(
        "instrument/gen-pulse",
        makeInstrument("pulse", "genesis", "lead", "Genesis pulse")
      );
      const out = await call("new_song", {
        chip: "genesis",
        id: "mega",
        instruments: { psg1: "lead" },
        mml: MEGA,
      });
      expect(out.isError).toBe(true);
      expect(out.text).toContain(
        'psg1 (pulse): "lead" was made for the nes chip'
      );
      expect(out.text).toContain("Instruments that fit it: gen-pulse");
      expect(host.docs.has("song/mega")).toBe(false);
      // nothing was written, not even the instruments it would have made
      expect([...host.docs.keys()].some((k) => k.includes("genesis-"))).toBe(
        false
      );
    });

    it("refuses an @id in the MML for the wrong chip, and says how to make one when none fits", async () => {
      const { call, host } = setup();
      const out = await call("new_song", {
        chip: "genesis",
        id: "mega",
        mml: { ...MEGA, psgNoise: "@drums o3 l8 c r c r" },
      });
      expect(out.isError).toBe(true);
      expect(out.text).toContain(
        'psgNoise (noise): "drums" was made for the nes chip'
      );
      expect(out.text).toContain(
        'new_instrument {"id":"genesis-drums","chip":"genesis","kind":"noise","preset":"drums"}'
      );
      expect(host.docs.has("song/mega")).toBe(false);
    });

    it("refuses an edit that points a channel at the wrong chip's instrument, but not one that leaves an old mismatch alone", async () => {
      const { call, host } = setup();
      await call("new_song", { chip: "genesis", id: "mega", mml: MEGA });
      const bad = await call("edit_document", {
        changes: [{ path: "/channels/8/instrument", value: "lead" }],
        ref: "song/mega",
      });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain(
        'psg3 (pulse): "lead" was made for the nes chip'
      );
      expect(
        (host.docs.get("song/mega") as Song).channels[8]?.instrument
      ).toBeNull();
      // a song that already had the mismatch can still be edited elsewhere
      const song = structuredClone(host.docs.get("song/mega") as Song);
      const psg3 = song.channels.find((c) => c.id === "psg3");
      if (psg3) {
        psg3.instrument = "lead";
      }
      host.docs.set("song/mega", song);
      const ok = await call("edit_document", {
        changes: [{ path: "/tempo", value: 111 }],
        ref: "song/mega",
      });
      expect(ok.isError).toBeUndefined();
      expect((host.docs.get("song/mega") as Song).tempo).toBe(111);
    });
  });

  it("creates an instrument and rejects a kind the chip lacks", async () => {
    const { call, host } = setup();
    const ok = await call("new_instrument", { id: "pluck", preset: "lead" });
    expect(ok.isError).toBeUndefined();
    expect(host.docs.has("instrument/pluck")).toBe(true);
    const bad = await call("new_instrument", {
      id: "fmbell",
      kind: "fm",
      preset: "bell",
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("has no fm channels");
  });

  it("describes a chip", async () => {
    const { call } = setup();
    const out = await call("chip_info", { chip: "gameboy" });
    expect(out.text).toContain("pulse1");
    expect(out.text).toContain("wave");
  });
});

describe("measuring", () => {
  it("summarizes a song render with its LUFS and clipping state", async () => {
    const { call, host } = setup();
    seedSong(host);
    host.analysis = analysisOf({
      loop: { end: 4, seamDiffDb: -52, start: 1 },
      lufs: -15,
    });
    const out = await call("render_analyze", { ref: "song/tune" });
    expect(out.summary).toBe("Rendered song/tune: -15.0 LUFS, no clipping");
    expect(out.text).toContain("loop seam -52.0 dB: clean");
    expect(out.text).toContain("loudness is inside the song target");
  });

  it("flags clipping and a loud sfx with what to change", async () => {
    const { call, host } = setup();
    host.analysis = analysisOf({
      clipped: { first: 10, frames: 12 },
      peakDb: -0.2,
    });
    const out = await call("render_analyze", { ref: "sfx/coin" });
    expect(out.summary).toContain("CLIPPING 12 frames");
    expect(out.text).toContain("CLIPPING: 12 frames");
    expect(out.text).toContain('lower "volume"');
  });

  it("reports a pitch glide", async () => {
    const { call } = setup();
    const out = await call("render_analyze", { ref: "sfx/coin" });
    expect(out.text).toContain("moves from C-5");
    expect(out.text).toContain("to C-6");
  });

  it("returns the pictures as images with labels", async () => {
    const { call } = setup();
    const out = await call("view_analysis", {
      images: ["waveform", "spectrogram"],
      ref: "sfx/coin",
    });
    expect(out.images?.map((i) => i.label)).toEqual([
      "waveform of sfx/coin",
      "spectrogram of sfx/coin",
    ]);
    expect(out.summary).toBe(
      "Looked at the waveform and spectrogram of sfx/coin"
    );
    const none = await call("view_analysis", {
      images: ["scopes"],
      ref: "sfx/coin",
    });
    expect(none.isError).toBe(true);
  });

  it("plays and stops through the host", async () => {
    const { call, host } = setup();
    expect((await call("play", { ref: "sfx/coin" })).summary).toBe(
      "Playing sfx/coin"
    );
    await call("stop", {});
    expect(host.calls).toContain("play sfx/coin");
    expect(host.calls).toContain("stop");
    expect((await call("play", { ref: "sfx/ghost" })).isError).toBe(true);
  });
});

describe("deleting", () => {
  it("deletes when the person confirms and tells the model to say so", async () => {
    const { call, host } = setup();
    const out = await call("delete_document", { ref: "sfx/coin" });
    expect(out.summary).toBe("Deleted sfx/coin");
    expect(out.text).toContain("Tell the person");
    expect(host.docs.has("sfx/coin")).toBe(false);
  });

  it("leaves the document when the person declines", async () => {
    const { call, host } = setup();
    host.confirmDelete = false;
    const out = await call("delete_document", { ref: "sfx/coin" });
    expect(out.summary).toBe("Delete of sfx/coin declined");
    expect(host.docs.has("sfx/coin")).toBe(true);
  });

  it("says when there is nothing to delete", async () => {
    const { call } = setup();
    expect((await call("delete_document", { ref: "sfx/none" })).isError).toBe(
      true
    );
  });
});

describe("output size", () => {
  it("cuts a huge result to the cap and says so", async () => {
    const { call, host } = setup();
    for (let i = 0; i < 400; i += 1) {
      host.docs.set(`sfx/s${i}`, host.docs.get("sfx/coin") as Sfx);
    }
    const out = await call("list_documents", { kind: "sfx" });
    expect(out.text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT + 200);
    expect(out.text).toContain("and 321 more");
  });
});

describe("change_song_chip", () => {
  /** The seeded NES song with a second pulse line and drums, so there is something to place on every channel. */
  function fuller() {
    const ctx = setup();
    seedSong(ctx.host);
    const tune = ctx.host.docs.get("song/tune") as Song;
    const song = normalizeSong(
      {
        ...tune,
        channels: [
          ...tune.channels,
          {
            id: "pulse2",
            instrument: "lead",
            kind: "pulse",
            mml: "o5 l4 e g e g",
          },
          {
            id: "noise",
            instrument: "drums",
            kind: "noise",
            mml: "o3 l8 c r d r c r d r",
          },
        ],
      },
      {
        bass: ctx.host.docs.get("instrument/bass") as Instrument,
        drums: ctx.host.docs.get("instrument/drums") as Instrument,
        lead: ctx.host.docs.get("instrument/lead") as Instrument,
      }
    );
    ctx.host.docs.set("song/tune", song.value);
    return ctx;
  }

  it("moves the song with its music, writes the new instruments first and reports what moved", async () => {
    const { call, host } = fuller();
    const out = await call("change_song_chip", {
      chip: "genesis",
      ref: "song/tune",
    });
    expect(out.isError).toBeUndefined();
    const song = host.docs.get("song/tune") as Song;
    expect(song.chip).toBe("genesis");
    const withMusic = song.channels.filter((c) => c.mml).map((c) => c.id);
    expect(withMusic.length).toBe(4);
    expect(withMusic).toContain("psgNoise");
    expect(out.text).toContain("pulse1 to fm");
    expect(out.text).toContain("noise to psgNoise");
    expect(out.text).toContain("New instruments:");
    // the instruments the song plays exist in the project, and the first write was an instrument
    const writes = host.calls.filter((c) => c.startsWith("write "));
    expect(writes[0]).toMatch(/^write instrument\//);
    expect(writes.at(-1)).toBe("write song/tune");
    for (const c of song.channels) {
      if (c.instrument) {
        expect(host.docs.has(`instrument/${c.instrument}`)).toBe(true);
      }
    }
    // the project's own instruments are untouched
    expect((host.docs.get("instrument/lead") as Instrument).kind).toBe("pulse");
  });

  it("says so when the song already has the chip, and refuses what is not a song", async () => {
    const { call, host } = fuller();
    const same = await call("change_song_chip", {
      chip: "nes",
      ref: "song/tune",
    });
    expect(same.text).toContain("already uses nes");
    const before = host.calls.length;
    const sfx = await call("change_song_chip", {
      chip: "gameboy",
      ref: "sfx/coin",
    });
    expect(sfx.isError).toBe(true);
    expect(host.calls.length).toBe(before);
  });

  it("makes edit_document send a chip change here instead of dropping channels", async () => {
    const { call, host } = fuller();
    const before = JSON.stringify(host.docs.get("song/tune"));
    const out = await call("edit_document", {
      changes: [{ path: "/chip", value: "genesis" }],
      ref: "song/tune",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("change_song_chip");
    expect(JSON.stringify(host.docs.get("song/tune"))).toBe(before);
  });
});
