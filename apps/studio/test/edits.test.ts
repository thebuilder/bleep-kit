/* The rules an instrument edit has to follow, and how the project view reads the studio server's export answer. */
import { describe, expect, it } from "vitest";
import { defaultInstrument } from "../src/lib/core.ts";
import { fitFmOps, toggleSidWave } from "../src/lib/instrument-edits.ts";
import { serverResultNodes } from "../src/views/project.ts";

describe("toggleSidWave", () => {
  const sid = () => defaultInstrument("sid", "c64");

  it("adds a waveform that is off and removes one that is on", () => {
    const i = sid();
    i.sid = { ...(i.sid as NonNullable<typeof i.sid>), waveforms: ["saw"] };
    toggleSidWave(i, "pulse");
    expect(i.sid.waveforms).toEqual(["saw", "pulse"]);
    toggleSidWave(i, "saw");
    expect(i.sid.waveforms).toEqual(["pulse"]);
  });

  it("keeps the last waveform on", () => {
    const i = sid();
    i.sid = { ...(i.sid as NonNullable<typeof i.sid>), waveforms: ["noise"] };
    toggleSidWave(i, "noise");
    expect(i.sid.waveforms).toEqual(["noise"]);
  });

  it("leaves an instrument without a SID section alone", () => {
    const i = defaultInstrument("pulse", "nes");
    toggleSidWave(i, "saw");
    expect(i.sid).toBeNull();
  });
});

describe("fitFmOps", () => {
  it("cuts a four operator patch to two for a two operator chip, and clamps the algorithm", () => {
    const i = defaultInstrument("fm", "genesis");
    expect(i.fm?.ops.length).toBe(4);
    (i.fm as NonNullable<typeof i.fm>).algorithm = 5;
    fitFmOps(i, "adlib");
    expect(i.fm?.ops.length).toBe(2);
    expect(i.fm?.algorithm).toBe(1);
  });

  it("fills a two operator patch back up for a four operator chip", () => {
    const i = defaultInstrument("fm", "adlib");
    expect(i.fm?.ops.length).toBe(2);
    const own = structuredClone(i.fm?.ops);
    fitFmOps(i, "genesis");
    expect(i.fm?.ops.length).toBe(4);
    // the two operators the user already shaped are kept as they were
    expect(i.fm?.ops.slice(0, 2)).toEqual(own);
  });

  it("does nothing when the count already fits, there is no chip, or the instrument is not FM", () => {
    const fm = defaultInstrument("fm", "genesis");
    const before = JSON.stringify(fm);
    fitFmOps(fm, "genesis");
    fitFmOps(fm, null);
    expect(JSON.stringify(fm)).toBe(before);
    const pulse = defaultInstrument("pulse", "nes");
    fitFmOps(pulse, "adlib");
    expect(pulse.fm).toBeNull();
    const noFmChip = defaultInstrument("fm", "genesis");
    fitFmOps(noFmChip, "nes");
    expect(noFmChip.fm?.ops.length).toBe(4);
  });
});

describe("serverResultNodes", () => {
  const text = (nodes: HTMLElement[]) =>
    nodes.map((n) => n.textContent).join("|");

  it("lists files given as names, as objects with a path or a file, and as anything else", () => {
    const nodes = serverResultNodes({
      files: ["a.ogg", { path: "b.ogg" }, { file: "c.ogg" }, 7, null],
    });
    expect(text(nodes)).toContain("Export finished: 5 files written.");
    expect(
      Array.from(nodes[1]?.querySelectorAll("li") ?? []).map(
        (li) => li.textContent
      )
    ).toEqual(["a.ogg", "b.ogg", "c.ogg", "7", "null"]);
  });

  it("reads the written list when there is no files list, and shows warnings and errors", () => {
    const nodes = serverResultNodes({
      errors: ["bad"],
      warnings: ["careful"],
      written: ["x.wav"],
    });
    expect(text(nodes)).toContain("1 files written");
    expect(nodes.find((n) => n.className === "warnline")?.textContent).toBe(
      "careful"
    );
    expect(nodes.find((n) => n.className === "bad")?.textContent).toBe("bad");
  });

  it("falls back to the raw answer when it names no files", () => {
    const nodes = serverResultNodes({ ok: true });
    expect(text(nodes)).toContain("see the result below");
    expect(nodes[1]?.tagName).toBe("PRE");
    expect(serverResultNodes(null)[1]?.textContent).toBe("null");
  });
});
