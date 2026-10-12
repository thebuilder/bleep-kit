/* Which instruments fit which channel, and swapping in ones that do (architecture.md section 2.9, Instruments). */

import { describe, expect, it } from "vitest";
import type { Instrument, Song } from "../src/index.ts";
import {
  defaultSong,
  findMisfits,
  fittingInstruments,
  fixMisfits,
  makeInstrument,
  mmlInstrumentIds,
  normalizeSong,
} from "../src/index.ts";

const nesLead = makeInstrument("pulse", "nes", "lead", "Lead");
const nesDrums = makeInstrument("noise", "nes", "drums", "Drums");
const fmBass = makeInstrument("fm", "genesis", "bass", "FM bass");
const anyPulse = makeInstrument("pulse", null, "lead", "Any pulse lead");

const project = (): Record<string, Instrument> => ({
  drums: nesDrums,
  "fm-bass": fmBass,
  lead: nesLead,
});

/** A genesis song: fm1 plays the bass on its own, psg1 plays the nes lead from its MML, psg3 from a row. */
function song(): Song {
  const s = defaultSong("genesis");
  const ch = (id: string) =>
    s.channels.find((c) => c.id === id) as Song["channels"][number];
  ch("fm1").instrument = "fm-bass";
  ch("psg1").instrument = "lead";
  ch("psg1").mml = "@lead o4 l8 c d e f ; @drums is only a comment";
  ch("psg3").instrument = "lead";
  ch("psgNoise").instrument = "drums";
  s.patterns = {
    a: {
      length: 4,
      tracks: {
        psg3: [{ fx: [], inst: "lead", note: 60, row: 0, vol: null }],
      },
    },
  };
  s.order = ["a"];
  return s;
}

const chipWarnings = (s: Song, i: Record<string, Instrument>) =>
  normalizeSong(s, i).issues.filter((x) =>
    x.message.includes("designed for chip")
  );

describe("fitting instruments", () => {
  it("lists the instruments of the channel's kind made for the chip or for none, the chip's own first", () => {
    const all = {
      ...project(),
      any: anyPulse,
      "gen-lead": makeInstrument("pulse", "genesis", "lead", "G"),
    };
    const psg = { id: "psg2", kind: "pulse" as const };
    expect(fittingInstruments(all, psg, "genesis")).toEqual([
      "gen-lead",
      "any",
    ]);
    expect(
      fittingInstruments(all, { id: "fm2", kind: "fm" }, "genesis")
    ).toEqual(["fm-bass"]);
    expect(
      fittingInstruments(all, { id: "noise", kind: "noise" }, "nes")
    ).toEqual(["drums"]);
  });

  it("finds an instrument named in an MML switch but not in a comment", () => {
    expect(mmlInstrumentIds("@a c @b-2 d ; @c e\n@a")).toEqual([
      "a",
      "b-2",
      "a",
    ]);
  });
});

describe("findMisfits and fixMisfits", () => {
  it("finds the nes instruments played on the genesis channels, whether by channel, row or MML", () => {
    const found = findMisfits(song(), project());
    expect(found.map((m) => `${m.channel}:${m.id}:${m.reason}`)).toEqual([
      "psg1:lead:chip",
      "psg3:lead:chip",
      "psgNoise:drums:chip",
    ]);
    expect(chipWarnings(song(), project()).length).toBeGreaterThan(0);
  });

  it("swaps in a fitting instrument of the project when there is one", () => {
    const insts = { ...project(), any: anyPulse };
    const r = fixMisfits(song(), insts, new Set(["lead"]));
    expect(r.swaps.map((s) => `${s.channel}:${s.from}>${s.to}`)).toEqual([
      "psg1:lead>any",
      "psg3:lead>any",
    ]);
    expect(r.created).toEqual([]);
    const psg1 = r.song.channels.find((c) => c.id === "psg1");
    expect(psg1?.instrument).toBe("any");
    expect(psg1?.mml).toBe("@any o4 l8 c d e f ; @drums is only a comment");
    expect(r.song.patterns.a?.tracks.psg3?.[0]?.inst).toBe("any");
    // the drums were not asked for
    expect(r.song.channels.find((c) => c.id === "psgNoise")?.instrument).toBe(
      "drums"
    );
  });

  it("makes one from the per-chip presets for the channel's kind and role when none fits, once for channels that share it", () => {
    const r = fixMisfits(song(), project());
    expect(r.created.sort()).toEqual(["genesis-drums", "genesis-lead"]);
    for (const id of r.created) {
      expect(r.instruments[id]?.chip).toBe("genesis");
    }
    expect(r.instruments["genesis-lead"]?.kind).toBe("pulse");
    expect(r.instruments["genesis-drums"]?.kind).toBe("noise");
    expect(r.song.channels.find((c) => c.id === "psg3")?.instrument).toBe(
      "genesis-lead"
    );
    expect(r.song.channels.find((c) => c.id === "psgNoise")?.instrument).toBe(
      "genesis-drums"
    );
    expect(findMisfits(r.song, r.instruments)).toEqual([]);
    expect(chipWarnings(r.song, r.instruments)).toEqual([]);
    // what it was given is untouched
    expect(project().lead).toEqual(nesLead);
    expect(song().channels.find((c) => c.id === "psg3")?.instrument).toBe(
      "lead"
    );
    expect(Object.keys(r.instruments)).toContain("lead");
  });

  it("does nothing to a song that already fits", () => {
    const fine = fixMisfits(song(), project(), new Set(["fm-bass"]));
    expect(fine.swaps).toEqual([]);
    expect(fine.song).toEqual(song());
    const all = fixMisfits(
      fixMisfits(song(), project()).song,
      fixMisfits(song(), project()).instruments
    );
    expect(all.swaps).toEqual([]);
  });

  it("does not judge instruments that do not exist, or any song of the custom chip", () => {
    const s = song();
    (
      s.channels.find((c) => c.id === "psg2") as Song["channels"][number]
    ).instrument = "ghost";
    expect(findMisfits(s, project()).some((m) => m.id === "ghost")).toBe(false);
    const custom = { ...defaultSong("custom"), chip: "custom" as const };
    custom.channels[0] = {
      ...(custom.channels[0] as Song["channels"][number]),
      instrument: "lead",
    };
    expect(findMisfits(custom, project())).toEqual([]);
  });

  it("finds an FM patch with the wrong number of operators", () => {
    const s = song();
    const opl = makeInstrument("fm", "adlib", "bass", "OPL bass");
    opl.chip = null;
    (
      s.channels.find((c) => c.id === "fm2") as Song["channels"][number]
    ).instrument = "opl";
    const found = findMisfits(s, { ...project(), opl });
    expect(found.find((m) => m.id === "opl")?.reason).toBe("operators");
    const r = fixMisfits(s, { ...project(), opl }, new Set(["opl"]));
    expect(r.song.channels.find((c) => c.id === "fm2")?.instrument).toBe(
      "fm-bass"
    );
  });
});
