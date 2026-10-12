import type { Instrument } from "@bleepkit/core";
import { describe, expect, it } from "vitest";
import { type AgentTool, createTools, type SampleInfo } from "../src/index.ts";
import { seededHost } from "./fake-host.ts";

const SNARE: SampleInfo = {
  baseNote: 60,
  bits: 8,
  bytes: 4410,
  finetune: 0,
  frames: 4410,
  id: "snare",
  loop: null,
  name: "Snare",
  rate: 11_025,
  seconds: 0.4,
  volume: 1,
};

const PAD: SampleInfo = {
  ...SNARE,
  finetune: -12,
  id: "pad",
  loop: { end: 4000, start: 1000 },
  name: "Pad",
};

function setup(chip: "amiga" | "nes" = "amiga") {
  const host = seededHost();
  host.chip = chip;
  host.sampleInfos = [SNARE, PAD];
  const tools = createTools(host);
  const call = (name: string, input: unknown) => {
    const tool = tools.find((t: AgentTool) => t.spec.name === name);
    if (!tool) {
      throw new Error(`no tool ${name}`);
    }
    return tool.run(input);
  };
  return { call, host };
}

describe("sample tools", () => {
  it("lists the samples without any audio", async () => {
    const { call } = setup();
    const out = await call("list_samples", {});
    expect(out.text).toContain("snare");
    expect(out.text).toContain("loop 1000..4000");
    expect(out.text).toContain("-12 cents");
    expect(out.text).not.toContain(String.fromCharCode(0x20_14));
  });

  it("says so when there are none", async () => {
    const { call, host } = setup();
    host.sampleInfos = [];
    expect((await call("list_samples", {})).text).toContain("no user samples");
  });

  it("reads one sample and the instruments that play it", async () => {
    const { call, host } = setup();
    const made = await call("set_instrument_sample", {
      instrument: "hit",
      sample: "snare",
    });
    expect(made.isError).toBeUndefined();
    const out = await call("read_sample", { id: "snare" });
    expect(out.text).toContain("instrument/hit");
    expect((await call("read_sample", { id: "pad" })).text).toContain(
      "no instrument yet"
    );
    expect((await call("read_sample", { id: "nope" })).isError).toBe(true);
    expect(host.docs.has("instrument/hit")).toBe(true);
  });

  it("creates a sample instrument on the project chip and points it at the sample", async () => {
    const { call, host } = setup();
    const out = await call("set_instrument_sample", {
      instrument: "hit",
      sample: "snare",
    });
    expect(out.isError).toBeUndefined();
    const inst = host.docs.get("instrument/hit") as Instrument;
    expect(inst.kind).toBe("sample");
    expect(inst.chip).toBe("amiga");
    expect(inst.sample?.userSample).toBe("snare");
  });

  it("repoints an existing sample instrument and keeps its other settings", async () => {
    const { call, host } = setup();
    await call("set_instrument_sample", { instrument: "hit", sample: "snare" });
    const before = host.docs.get("instrument/hit") as Instrument;
    await call("set_instrument_sample", { instrument: "hit", sample: "pad" });
    const after = host.docs.get("instrument/hit") as Instrument;
    expect(after.sample?.userSample).toBe("pad");
    expect(after.name).toBe(before.name);
  });

  it("refuses a missing sample, a non-sample instrument and a chip without samples", async () => {
    const { call, host } = setup();
    const missing = await call("set_instrument_sample", {
      instrument: "hit",
      sample: "ghost",
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("list_samples");
    const writes = host.calls.length;
    const notSample = await call("set_instrument_sample", {
      instrument: "lead",
      sample: "snare",
    });
    expect(notSample.isError).toBe(true);
    expect(notSample.text).toContain("is a pulse instrument");
    expect(host.calls.length).toBe(writes);
    const nes = setup("nes");
    const refused = await nes.call("set_instrument_sample", {
      instrument: "hit",
      sample: "snare",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("no sample channels");
    expect(nes.host.docs.has("instrument/hit")).toBe(false);
  });

  it("resamples a document into a new sample", async () => {
    const { call, host } = setup();
    const out = await call("resample", {
      bits: 8,
      id: "coin-crush",
      rate: 8000,
      ref: "sfx/coin",
    });
    expect(out.isError).toBeUndefined();
    expect(out.text).toContain("coin-crush");
    expect(host.calls).toContain("resample sfx/coin coin-crush");
    expect(host.sampleInfos.some((s) => s.id === "coin-crush")).toBe(true);
  });

  it("refuses bad resample requests", async () => {
    const { call } = setup();
    expect((await call("resample", { id: "x", ref: "coin" })).isError).toBe(
      true
    );
    expect(
      (await call("resample", { id: "Bad Id", ref: "sfx/coin" })).isError
    ).toBe(true);
    expect(
      (await call("resample", { bits: 12, id: "x", ref: "sfx/coin" })).isError
    ).toBe(true);
    expect(
      (await call("resample", { id: "snare", ref: "sfx/coin" })).text
    ).toContain("already");
    expect((await call("resample", { id: "x", ref: "sfx/nope" })).isError).toBe(
      true
    );
  });
});
