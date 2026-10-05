import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav } from "../../src/tools/wav.ts";
import { render, sine } from "./helpers.ts";

function tagAt(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(
    bytes[at] ?? 0,
    bytes[at + 1] ?? 0,
    bytes[at + 2] ?? 0,
    bytes[at + 3] ?? 0
  );
}

/** Every chunk of a RIFF file as [tag, offset of its body, size]. */
function chunksOf(bytes: Uint8Array): [string, number, number][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: [string, number, number][] = [];
  let at = 12;
  while (at + 8 <= bytes.length) {
    const size = view.getUint32(at + 4, true);
    out.push([tagAt(bytes, at), at + 8, size]);
    at += 8 + size + (size % 2);
  }
  return out;
}

function ascii(bytes: Uint8Array, at: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i += 1) {
    s += String.fromCharCode(bytes[at + i] ?? 0);
  }
  return s;
}

/** Samples that are exact 16 bit values, so a 16 bit round trip must be bit exact. */
function exact16(frames: number, seed: number): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const v = Math.round(
      Math.sin(i * 0.37 + seed) * 32_000 + Math.cos(i * 1.9) * 700
    );
    out[i] = Math.max(-32_768, Math.min(32_767, v)) / 32_768;
  }
  return out;
}

describe("encodeWav and decodeWav", () => {
  it("round trips 16 bit PCM bit exactly", () => {
    const src = render(48_000, exact16(5000, 0), exact16(5000, 1));
    const bytes = encodeWav(src);
    const back = decodeWav(bytes);
    expect(back.sampleRate).toBe(48_000);
    expect(back.frames).toBe(5000);
    expect(back.channels).toHaveLength(2);
    expect(Array.from(back.channels[0] ?? [])).toEqual(
      Array.from(src.channels[0] ?? [])
    );
    expect(Array.from(back.channels[1] ?? [])).toEqual(
      Array.from(src.channels[1] ?? [])
    );
  });

  it("round trips 32 bit float bit exactly, including values beyond full scale", () => {
    const left = sine(44_100, 0.2, 440, 0.77);
    const right = sine(44_100, 0.2, 331, 1.5);
    const back = decodeWav(
      encodeWav(render(44_100, left, right), { bits: 32 })
    );
    expect(back.sampleRate).toBe(44_100);
    expect(Array.from(back.channels[0] ?? [])).toEqual(Array.from(left));
    expect(Array.from(back.channels[1] ?? [])).toEqual(Array.from(right));
  });

  it("round trips 24 bit PCM within one step", () => {
    const left = sine(48_000, 0.1, 1000, 0.9);
    const back = decodeWav(encodeWav(render(48_000, left), { bits: 24 }));
    let worst = 0;
    for (let i = 0; i < left.length; i += 1) {
      worst = Math.max(
        worst,
        Math.abs((back.channels[0]?.[i] ?? 0) - (left[i] ?? 0))
      );
    }
    expect(worst).toBeLessThanOrEqual(1 / 8_388_608);
  });

  it("writes the right header fields", () => {
    const bytes = encodeWav(render(44_100, sine(44_100, 0.01, 440, 0.5)));
    const view = new DataView(bytes.buffer);
    expect(tagAt(bytes, 0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    expect(tagAt(bytes, 8)).toBe("WAVE");
    const fmt = chunksOf(bytes).find((c) => c[0] === "fmt ");
    expect(fmt).toBeDefined();
    const at = fmt?.[1] ?? 0;
    expect(view.getUint16(at, true)).toBe(1);
    expect(view.getUint16(at + 2, true)).toBe(2);
    expect(view.getUint32(at + 4, true)).toBe(44_100);
    expect(view.getUint32(at + 8, true)).toBe(44_100 * 4);
    expect(view.getUint16(at + 12, true)).toBe(4);
    expect(view.getUint16(at + 14, true)).toBe(16);
  });

  it("marks 32 bit output as IEEE float with a fact chunk", () => {
    const bytes = encodeWav(render(48_000, sine(48_000, 0.01, 440, 0.5)), {
      bits: 32,
    });
    const view = new DataView(bytes.buffer);
    const tags = chunksOf(bytes).map((c) => c[0]);
    expect(tags).toContain("fact");
    const fmt = chunksOf(bytes).find((c) => c[0] === "fmt ");
    expect(view.getUint16(fmt?.[1] ?? 0, true)).toBe(3);
  });

  it("clamps 16 bit output instead of wrapping", () => {
    const loud = Float32Array.from([2, -2, 1, -1]);
    const back = decodeWav(encodeWav(render(48_000, loud)));
    expect(back.channels[0]?.[0]).toBeCloseTo(32_767 / 32_768, 6);
    expect(back.channels[0]?.[1]).toBe(-1);
    expect(back.channels[0]?.[2]).toBeCloseTo(32_767 / 32_768, 6);
    expect(back.channels[0]?.[3]).toBe(-1);
  });

  it("writes a smpl chunk with one forward loop and reads it back", () => {
    const left = sine(48_000, 1, 220, 0.5);
    const src = render(48_000, left, left, {
      loopEnd: 40_000,
      loopStart: 12_000,
    });
    const bytes = encodeWav(src);
    const smpl = chunksOf(bytes).find((c) => c[0] === "smpl");
    expect(smpl).toBeDefined();
    const view = new DataView(bytes.buffer);
    const at = smpl?.[1] ?? 0;
    expect(smpl?.[2]).toBe(36 + 24);
    expect(view.getUint32(at + 8, true)).toBe(Math.round(1e9 / 48_000));
    expect(view.getUint32(at + 28, true)).toBe(1);
    // loop: cue id, type 0 (forward), start, end (the last sample played), fraction, play count
    expect(view.getUint32(at + 36 + 4, true)).toBe(0);
    expect(view.getUint32(at + 36 + 8, true)).toBe(12_000);
    expect(view.getUint32(at + 36 + 12, true)).toBe(39_999);
    const back = decodeWav(bytes);
    expect(back.loopStart).toBe(12_000);
    expect(back.loopEnd).toBe(40_000);
  });

  it("omits the smpl chunk without a loop", () => {
    const bytes = encodeWav(render(48_000, sine(48_000, 0.05, 440, 0.5)));
    expect(chunksOf(bytes).map((c) => c[0])).not.toContain("smpl");
    const back = decodeWav(bytes);
    expect(back.loopStart).toBeUndefined();
    expect(back.loopEnd).toBeUndefined();
  });

  it("writes LIST INFO with ISFT and ICMT", () => {
    const bytes = encodeWav(render(48_000, sine(48_000, 0.05, 440, 0.5)), {
      id: "title-theme",
      software: "bleepkit 0.1.0",
    });
    const list = chunksOf(bytes).find((c) => c[0] === "LIST");
    expect(list).toBeDefined();
    const at = list?.[1] ?? 0;
    expect(ascii(bytes, at, 4)).toBe("INFO");
    const info = ascii(bytes, at + 4, (list?.[2] ?? 0) - 4);
    expect(info).toContain("ISFT");
    expect(info).toContain("bleepkit 0.1.0\u0000");
    expect(info).toContain("ICMT");
    expect(info).toContain("title-theme\u0000");
  });

  it("defaults ISFT to bleepkit and leaves ICMT out without an id", () => {
    const bytes = encodeWav(render(48_000, sine(48_000, 0.05, 440, 0.5)));
    const list = chunksOf(bytes).find((c) => c[0] === "LIST");
    const info = ascii(bytes, (list?.[1] ?? 0) + 4, (list?.[2] ?? 0) - 4);
    expect(info).toContain("bleepkit\u0000");
    expect(info).not.toContain("ICMT");
  });

  it("keeps the RIFF size right when chunks need padding bytes", () => {
    // 8 bit data of an odd size is not producible here, but an odd-length id pads the LIST entry
    const bytes = encodeWav(
      render(48_000, Float32Array.from([0.1, 0.2, 0.3])),
      { id: "a", software: "x" }
    );
    expect(bytes.length % 2).toBe(0);
    expect(new DataView(bytes.buffer).getUint32(4, true)).toBe(
      bytes.length - 8
    );
    expect(decodeWav(bytes).frames).toBe(3);
  });

  it("reads 8 bit and mono files and keeps the channel count", () => {
    const header = new Uint8Array(44 + 4);
    const v = new DataView(header.buffer);
    const put = (at: number, s: string) => {
      for (let i = 0; i < s.length; i += 1) {
        v.setUint8(at + i, s.charCodeAt(i));
      }
    };
    put(0, "RIFF");
    v.setUint32(4, 40, true);
    put(8, "WAVEfmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true);
    v.setUint32(28, 8000, true);
    v.setUint16(32, 1, true);
    v.setUint16(34, 8, true);
    put(36, "data");
    v.setUint32(40, 4, true);
    header.set([128, 255, 0, 192], 44);
    const back = decodeWav(header);
    expect(back.channels).toHaveLength(1);
    expect(back.sampleRate).toBe(8000);
    expect(Array.from(back.channels[0] ?? [])).toEqual([0, 127 / 128, -1, 0.5]);
  });

  it("copes with a data chunk that claims more bytes than the file holds", () => {
    const bytes = encodeWav(render(48_000, exact16(100, 0)));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const data = chunksOf(bytes).find((c) => c[0] === "data");
    view.setUint32((data?.[1] ?? 8) - 4, 0xff_ff_ff_ff, true);
    const back = decodeWav(bytes);
    expect(back.frames).toBeGreaterThanOrEqual(100);
  });

  it("rejects files that are not WAV and bad options", () => {
    expect(() => decodeWav(Uint8Array.from([1, 2, 3, 4]))).toThrow(
      "not a RIFF WAVE"
    );
    expect(() =>
      encodeWav(render(48_000, new Float32Array(4)), { bits: 12 as 16 })
    ).toThrow("bits");
    expect(() =>
      encodeWav({ channels: [], events: [], frames: 0, sampleRate: 48_000 })
    ).toThrow("no channels");
  });

  it("handles an empty render", () => {
    const back = decodeWav(encodeWav(render(48_000, new Float32Array(0))));
    expect(back.frames).toBe(0);
    expect(back.channels).toHaveLength(2);
  });
});
