import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav } from "../../src/tools/wav.ts";
import { render, sine } from "./helpers.ts";

/*
 * Expectations here come from the RIFF/WAVE format, not from the encoder:
 * - the byte layout tests spell out every byte of small files with the `bytes` builder below;
 * - the `FFMPEG_*` and `LIBSNDFILE_LOOP` fixtures are real files written by other software (ffmpeg 6, libsndfile 1.2.2),
 *   so the decoder is checked against files it did not write;
 * - libsndfile also reads our smpl chunk back as the loop we meant (start 1, end 3 for a stored dwEnd of 2) and
 *   ffprobe and python's wave module read our 16, 24 and 32 bit files, which is how the golden bytes were cross-checked.
 */

type Part = string | number[];

const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number): number[] => [
  n & 0xff,
  (n >> 8) & 0xff,
  (n >> 16) & 0xff,
  (n >>> 24) & 0xff,
];
const i16 = (n: number): number[] => u16(n & 0xff_ff);
const i24 = (n: number): number[] => [
  n & 0xff,
  (n >> 8) & 0xff,
  (n >> 16) & 0xff,
];
const f32 = (n: number): number[] => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, n, true);
  return Array.from(out);
};

/** Concatenate ASCII tags (strings) and byte lists. */
function bytes(...parts: Part[]): number[] {
  return parts.flatMap((p) =>
    typeof p === "string" ? Array.from(p, (c) => c.charCodeAt(0)) : p
  );
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.replaceAll(/\s/g, "");
  return Uint8Array.from({ length: clean.length / 2 }, (_, i) =>
    Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  );
}

/** One RIFF chunk with its size and, for an odd size, the pad byte. */
function chunk(tag: string, body: number[]): number[] {
  return bytes(tag, u32(body.length), body, body.length % 2 === 1 ? [0] : []);
}

/** A RIFF/WAVE file around the given chunks, with a correct RIFF size. */
function riff(...chunks: number[][]): Uint8Array {
  const body = chunks.flat();
  return Uint8Array.from(bytes("RIFF", u32(4 + body.length), "WAVE", body));
}

function fmtBody(opts: {
  bits: number;
  channels: number;
  format: number;
  rate: number;
}): number[] {
  const blockAlign = (opts.channels * opts.bits) / 8;
  return bytes(
    u16(opts.format),
    u16(opts.channels),
    u32(opts.rate),
    u32(opts.rate * blockAlign),
    u16(blockAlign),
    u16(opts.bits)
  );
}

function tagAt(data: Uint8Array, at: number): string {
  return String.fromCharCode(...Array.from(data.subarray(at, at + 4)));
}

/** Every chunk of a RIFF file as [tag, offset of its body, size], following the pad bytes; the chain must end exactly at the end of the file. */
function chunksOf(data: Uint8Array): [string, number, number][] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: [string, number, number][] = [];
  let at = 12;
  while (at + 8 <= data.length) {
    const size = view.getUint32(at + 4, true);
    out.push([tagAt(data, at), at + 8, size]);
    at += 8 + size + (size % 2);
  }
  expect(at).toBe(data.length);
  return out;
}

/** The text entries of the LIST INFO chunk as {tag: text} (the terminating zero removed). */
function infoEntries(data: Uint8Array): Record<string, string> {
  const list = chunksOf(data).find((c) => c[0] === "LIST");
  expect(list).toBeDefined();
  const [, body, size] = list ?? ["", 0, 0];
  expect(tagAt(data, body)).toBe("INFO");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: Record<string, string> = {};
  let at = body + 4;
  while (at < body + size) {
    const len = view.getUint32(at + 4, true);
    const text = String.fromCharCode(
      ...Array.from(data.subarray(at + 8, at + 8 + len))
    );
    expect(text.endsWith("\u0000")).toBe(true);
    out[tagAt(data, at)] = text.slice(0, -1);
    at += 8 + len + (len % 2);
  }
  expect(at).toBe(body + size);
  return out;
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

const mono = (samples: number[], sampleRate: number, extra = {}) => ({
  channels: [Float32Array.from(samples)],
  events: [],
  frames: samples.length,
  sampleRate,
  ...extra,
});

/* Files written by ffmpeg (Lavf60.16.100) from 16 bit stereo PCM at 8 kHz, L = LEFT, R = RIGHT, converted with
   -c:a pcm_s24le / pcm_s32le / pcm_f64le. ffmpeg writes WAVE_FORMAT_EXTENSIBLE for all three, then a LIST chunk
   (and a fact chunk for float), then data. */
const LEFT = [0, 16_384, -16_384, 32_767, -32_768];
const RIGHT = [1, -1, 4096, -4096, 32_767];
const FFMPEG_S24 =
  "524946467c00000057415645666d742028000000feff0200401f000080bb0000" +
  "0600180016001800030000000100000000001000800000aa00389b714c495354" +
  "1a000000494e464f495346540e0000004c61766636302e31362e313030006461" +
  "74611e00000000000000010000004000ffff0000c000001000ff7f0000f00000" +
  "8000ff7f";
const FFMPEG_S32 =
  "524946468600000057415645666d742028000000feff0200401f000000fa0000" +
  "0800200016002000030000000100000000001000800000aa00389b714c495354" +
  "1a000000494e464f495346540e0000004c61766636302e31362e313030006461" +
  "7461280000000000000000000100000000400000ffff000000c0000000100000" +
  "ff7f000000f0000000800000ff7f";
const FFMPEG_F64 =
  "52494646ba00000057415645666d742028000000feff0200401f000000f40100" +
  "1000400016004000030000000300000000001000800000aa00389b7166616374" +
  "04000000050000004c4953541a000000494e464f495346540e0000004c617666" +
  "36302e31362e3130300064617461500000000000000000000000000000000000" +
  "003f000000000000e03f00000000000000bf000000000000e0bf000000000000" +
  "c03f00000000c0ffef3f000000000000c0bf000000000000f0bf00000000c0ff" +
  "ef3f";

/* A file written by libsndfile 1.2.2: 10 frames of 16 bit mono at 8 kHz holding i * 1000, with one forward loop that
   libsndfile was told runs from frame 2 up to (not including) frame 6. It puts smpl before data. */
const LIBSNDFILE_LOOP =
  "524946467c00000057415645666d74201000000001000100401f0000803e0000" +
  "02001000736d706c3c000000000000000000000048e801003c00000000000000" +
  "0000000000000000010000000000000000000000000000000200000005000000" +
  "000000000000000064617461140000000000e803d007b80ba00f88137017581b" +
  "401f2823";

describe("encodeWav byte layout", () => {
  it("writes a 16 bit stereo file with fmt, data and LIST INFO exactly as the RIFF layout says", () => {
    const left = [0, 0.5, -1];
    const right = [1 / 32_768, -1 / 32_768, 1];
    const file = encodeWav(
      render(8000, Float32Array.from(left), Float32Array.from(right)),
      { id: "ab", software: "t" }
    );
    expect(Array.from(file)).toEqual(
      bytes(
        "RIFF",
        u32(82),
        "WAVE",
        "fmt ",
        u32(16),
        u16(1), // PCM
        u16(2), // channels
        u32(8000),
        u32(32_000), // byte rate: 8000 frames * 4 bytes
        u16(4), // block align
        u16(16),
        "data",
        u32(12),
        i16(0),
        i16(1), // frame 0: left, right
        i16(16_384),
        i16(-1), // frame 1: 0.5 is half of 32768
        i16(-32_768),
        i16(32_767), // frame 2: -1 is full scale negative; +1 stops one step short of 32768
        "LIST",
        u32(26),
        "INFO",
        "ISFT",
        u32(2),
        "t\u0000",
        "ICMT",
        u32(3),
        "ab\u0000",
        [0] // the pad byte after an odd sized entry
      )
    );
  });

  it("writes 24 bit samples little endian, clamps at the 24 bit limits, pads odd data and puts smpl between data and LIST", () => {
    const file = encodeWav(
      mono([0.5, -0.5, 2], 8000, { loopEnd: 3, loopStart: 1 }),
      { bits: 24, id: "ab", software: "t" }
    );
    expect(Array.from(file)).toEqual(
      bytes(
        "RIFF",
        u32(4 + 24 + (8 + 10) + 68 + 34),
        "WAVE",
        "fmt ",
        u32(16),
        u16(1),
        u16(1),
        u32(8000),
        u32(24_000),
        u16(3),
        u16(24),
        "data",
        u32(9),
        i24(0x40_00_00),
        i24(-0x40_00_00),
        i24(0x7f_ff_ff), // 2.0 clamps instead of wrapping
        [0], // pad byte: 9 data bytes is odd
        "smpl",
        u32(60),
        u32(0), // manufacturer
        u32(0), // product
        u32(125_000), // sample period in ns at 8 kHz
        u32(60), // MIDI unity note
        u32(0), // pitch fraction
        u32(0), // SMPTE format
        u32(0), // SMPTE offset
        u32(1), // one loop
        u32(0), // sampler data bytes
        u32(0), // loop cue id
        u32(0), // loop type: forward
        u32(1), // start
        u32(2), // end: the last sample played, so the exclusive loopEnd 3 minus one
        u32(0), // fraction
        u32(0), // play count: infinite
        "LIST",
        u32(26),
        "INFO",
        "ISFT",
        u32(2),
        "t\u0000",
        "ICMT",
        u32(3),
        "ab\u0000",
        [0]
      )
    );
  });

  it("writes 32 bit output as IEEE float with an 18 byte fmt, a fact chunk, and no clamping", () => {
    const file = encodeWav(
      render(
        8000,
        Float32Array.from([0.5, 1.5]),
        Float32Array.from([-2, 0.25])
      ),
      { bits: 32, id: "ab", software: "t" }
    );
    expect(Array.from(file)).toEqual(
      bytes(
        "RIFF",
        u32(4 + 26 + 12 + 24 + 34),
        "WAVE",
        "fmt ",
        u32(18),
        u16(3), // IEEE float
        u16(2),
        u32(8000),
        u32(64_000),
        u16(8),
        u16(32),
        u16(0), // cbSize
        "fact",
        u32(4),
        u32(2), // sample frames
        "data",
        u32(16),
        f32(0.5),
        f32(-2),
        f32(1.5),
        f32(0.25),
        "LIST",
        u32(26),
        "INFO",
        "ISFT",
        u32(2),
        "t\u0000",
        "ICMT",
        u32(3),
        "ab\u0000",
        [0]
      )
    );
  });

  it("clamps 16 bit samples at the 16 bit limits instead of wrapping", () => {
    const loud = Float32Array.from([2, -2, 1, -1]);
    const file = encodeWav(render(8000, loud));
    const [, data] = chunksOf(file).find((c) => c[0] === "data") ?? ["", 0, 0];
    // both channels carry the same samples: 2 and 1 clamp to the top, -2 and -1 reach the bottom
    expect(Array.from(file.subarray(data, data + 16))).toEqual(
      bytes(
        i16(32_767),
        i16(32_767),
        i16(-32_768),
        i16(-32_768),
        i16(32_767),
        i16(32_767),
        i16(-32_768),
        i16(-32_768)
      )
    );
  });

  it("pads an odd sized LIST entry and keeps every chunk on an even boundary", () => {
    // "ab" plus its terminating zero is 3 bytes: the entry size says 3 and one pad byte follows
    const file = encodeWav(render(48_000, Float32Array.from([0.1, 0.2, 0.3])), {
      id: "ab",
      software: "xy",
    });
    expect(file.length % 2).toBe(0);
    expect(new DataView(file.buffer).getUint32(4, true)).toBe(file.length - 8);
    expect(infoEntries(file)).toEqual({ ICMT: "ab", ISFT: "xy" });
    expect(decodeWav(file).frames).toBe(3);
  });

  it("writes ISFT bleepkit by default, leaves ICMT out without an id and writes printable ASCII only", () => {
    const plain = encodeWav(render(48_000, sine(48_000, 0.01, 440, 0.5)));
    expect(infoEntries(plain)).toEqual({ ISFT: "bleepkit" });
    const empty = encodeWav(render(48_000, sine(48_000, 0.01, 440, 0.5)), {
      id: "",
    });
    expect(infoEntries(empty)).toEqual({ ISFT: "bleepkit" });
    const accented = encodeWav(render(48_000, sine(48_000, 0.01, 440, 0.5)), {
      id: "café ☃",
    });
    expect(infoEntries(accented).ICMT).toBe("caf? ?");
  });

  it("writes a smpl chunk with one forward loop that other software reads the same way", () => {
    const left = sine(48_000, 1, 220, 0.5);
    const src = render(48_000, left, left, {
      loopEnd: 40_000,
      loopStart: 12_000,
    });
    const bytesOut = encodeWav(src);
    const smpl = chunksOf(bytesOut).find((c) => c[0] === "smpl");
    expect(smpl).toBeDefined();
    const view = new DataView(bytesOut.buffer);
    const at = smpl?.[1] ?? 0;
    expect(smpl?.[2]).toBe(36 + 24);
    expect(view.getUint32(at + 8, true)).toBe(Math.round(1e9 / 48_000));
    expect(view.getUint32(at + 28, true)).toBe(1);
    // loop: cue id, type 0 (forward), start, end (the last sample played), fraction, play count
    expect(view.getUint32(at + 36 + 4, true)).toBe(0);
    expect(view.getUint32(at + 36 + 8, true)).toBe(12_000);
    expect(view.getUint32(at + 36 + 12, true)).toBe(39_999);
    const back = decodeWav(bytesOut);
    expect(back.loopStart).toBe(12_000);
    expect(back.loopEnd).toBe(40_000);
  });

  it.each([
    ["no loop points", {}],
    ["a start without an end", { loopStart: 100 }],
    ["an end without a start", { loopEnd: 100 }],
    ["an end that equals the start", { loopEnd: 100, loopStart: 100 }],
    ["an end before the start", { loopEnd: 50, loopStart: 100 }],
  ])("omits the smpl chunk for %s", (_name, loop) => {
    const file = encodeWav(
      render(48_000, sine(48_000, 0.05, 440, 0.5), undefined, loop)
    );
    expect(chunksOf(file).map((c) => c[0])).not.toContain("smpl");
    const back = decodeWav(file);
    expect(back.loopStart).toBeUndefined();
    expect(back.loopEnd).toBeUndefined();
  });

  it("writes the header sizes and rates from the format for every depth and channel count", () => {
    const frames = 10;
    // [bits, channels, expected byte rate at 44.1 kHz, expected block align]
    const cases: [16 | 24 | 32, number, number, number][] = [
      [16, 1, 88_200, 2],
      [16, 2, 176_400, 4],
      [24, 1, 132_300, 3],
      [24, 2, 264_600, 6],
      [32, 1, 176_400, 4],
      [32, 2, 352_800, 8],
    ];
    for (const [bits, channels, byteRate, blockAlign] of cases) {
      const planes = Array.from(
        { length: channels },
        () => new Float32Array(frames)
      );
      const file = encodeWav(
        { channels: planes, events: [], frames, sampleRate: 44_100 },
        { bits }
      );
      const view = new DataView(file.buffer);
      const fmt = chunksOf(file).find((c) => c[0] === "fmt ");
      const at = fmt?.[1] ?? 0;
      const label = `${bits} bit, ${channels} channel`;
      expect(view.getUint16(at + 2, true), label).toBe(channels);
      expect(view.getUint32(at + 4, true), label).toBe(44_100);
      expect(view.getUint32(at + 8, true), label).toBe(byteRate);
      expect(view.getUint16(at + 12, true), label).toBe(blockAlign);
      expect(view.getUint16(at + 14, true), label).toBe(bits);
      const data = chunksOf(file).find((c) => c[0] === "data");
      expect(data?.[2], label).toBe(frames * blockAlign);
      expect(view.getUint32(4, true), label).toBe(file.length - 8);
    }
  });
});

describe("decodeWav", () => {
  it("round trips 16 bit PCM bit exactly", () => {
    const src = render(48_000, exact16(5000, 0), exact16(5000, 1));
    const back = decodeWav(encodeWav(src));
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

  it.each([
    ["24 bit PCM", FFMPEG_S24],
    ["32 bit PCM", FFMPEG_S32],
    ["64 bit float", FFMPEG_F64],
  ])(
    "reads the %s file ffmpeg writes (extensible format, LIST before data)",
    (_name, hex) => {
      const back = decodeWav(fromHex(hex));
      expect(back.sampleRate).toBe(8000);
      expect(back.frames).toBe(5);
      expect(back.channels).toHaveLength(2);
      expect(Array.from(back.channels[0] ?? [])).toEqual(
        LEFT.map((v) => v / 32_768)
      );
      expect(Array.from(back.channels[1] ?? [])).toEqual(
        RIGHT.map((v) => v / 32_768)
      );
      expect(back.loopStart).toBeUndefined();
    }
  );

  it("reads the loop libsndfile writes, with smpl before data", () => {
    const back = decodeWav(fromHex(LIBSNDFILE_LOOP));
    expect(back.frames).toBe(10);
    expect(back.sampleRate).toBe(8000);
    expect(back.channels).toHaveLength(1);
    expect(Array.from(back.channels[0] ?? [])).toEqual(
      Array.from({ length: 10 }, (_, i) => (i * 1000) / 32_768)
    );
    expect(back.loopStart).toBe(2);
    expect(back.loopEnd).toBe(6);
  });

  it("reads 8 bit unsigned samples and keeps a mono file mono", () => {
    const file = riff(
      chunk("fmt ", fmtBody({ bits: 8, channels: 1, format: 1, rate: 8000 })),
      chunk("data", [128, 255, 0, 192])
    );
    const back = decodeWav(file);
    expect(back.channels).toHaveLength(1);
    expect(back.sampleRate).toBe(8000);
    expect(Array.from(back.channels[0] ?? [])).toEqual([0, 127 / 128, -1, 0.5]);
  });

  it("skips unknown chunks of odd size, whatever their position, using the pad byte", () => {
    const file = riff(
      chunk("JUNK", [1, 2, 3]),
      chunk("fmt ", fmtBody({ bits: 16, channels: 1, format: 1, rate: 8000 })),
      chunk("odd ", [9]),
      chunk("data", [...i16(16_384), ...i16(-16_384)]),
      chunk("LIST", bytes("INFO"))
    );
    const back = decodeWav(file);
    expect(back.frames).toBe(2);
    expect(Array.from(back.channels[0] ?? [])).toEqual([0.5, -0.5]);
  });

  it("finds a smpl loop after an odd sized data chunk (24 bit mono, pad byte)", () => {
    const back = decodeWav(
      encodeWav(mono([0.1, 0.2, 0.3], 8000, { loopEnd: 3, loopStart: 1 }), {
        bits: 24,
      })
    );
    expect(back.frames).toBe(3);
    expect(back.loopStart).toBe(1);
    expect(back.loopEnd).toBe(3);
  });

  it.each([
    ["an end past the data is clamped to the data", 1, 2, 99, 2, 10],
    [
      "a loop that starts at the end of the data is ignored",
      1,
      10,
      12,
      null,
      null,
    ],
    ["a loop that ends before it starts is ignored", 1, 5, 2, null, null],
    ["a smpl chunk with zero loops has no loop", 0, 2, 6, null, null],
  ])(
    "applies smpl loops sensibly: %s",
    (_name, loops, dwStart, dwEnd, start, end) => {
      const smpl = bytes(
        u32(0), // manufacturer
        u32(0), // product
        u32(125_000), // sample period
        u32(60), // unity note
        u32(0), // pitch fraction
        u32(0), // SMPTE format
        u32(0), // SMPTE offset
        u32(loops), // number of loops
        u32(0), // sampler data
        u32(0), // cue id
        u32(0), // forward
        u32(dwStart),
        u32(dwEnd),
        u32(0), // fraction
        u32(0) // play count
      );
      const file = riff(
        chunk(
          "fmt ",
          fmtBody({ bits: 16, channels: 1, format: 1, rate: 8000 })
        ),
        chunk(
          "data",
          Array.from({ length: 20 }, () => 0)
        ),
        chunk("smpl", smpl)
      );
      const back = decodeWav(file);
      expect(back.frames).toBe(10);
      expect(back.loopStart ?? null).toBe(start);
      expect(back.loopEnd ?? null).toBe(end);
    }
  );

  it("reads a file whose data size says 'until the end' (streamed output) as exactly the samples present", () => {
    const whole = encodeWav(render(48_000, exact16(100, 0), exact16(100, 1)));
    const data = chunksOf(whole).find((c) => c[0] === "data");
    const [, at = 0, size = 0] = data ?? [];
    // cut the trailing LIST off and write the unknown-length marker 0xffffffff
    const streamed = whole.slice(0, at + size);
    new DataView(streamed.buffer).setUint32(at - 4, 0xff_ff_ff_ff, true);
    const back = decodeWav(streamed);
    expect(back.frames).toBe(100);
    expect(Array.from(back.channels[1] ?? [])).toEqual(
      Array.from(exact16(100, 1))
    );
  });

  it("drops a partial frame at the end of a truncated file", () => {
    const whole = encodeWav(render(48_000, exact16(100, 0), exact16(100, 1)));
    const data = chunksOf(whole).find((c) => c[0] === "data");
    const [, at = 0, size = 0] = data ?? [];
    // 6 bytes short: 100 frames of 4 bytes become 98 whole frames and 2 stray bytes
    const truncated = whole.slice(0, at + size - 6);
    const back = decodeWav(truncated);
    expect(back.frames).toBe(98);
    expect(Array.from(back.channels[0] ?? [])).toEqual(
      Array.from(exact16(100, 0).subarray(0, 98))
    );
  });

  it("decodes an empty render to zero frames and keeps two channels", () => {
    const back = decodeWav(encodeWav(render(48_000, new Float32Array(0))));
    expect(back.frames).toBe(0);
    expect(back.channels).toHaveLength(2);
  });
});

describe("encodeWav and decodeWav errors", () => {
  const goodFmt = chunk(
    "fmt ",
    fmtBody({ bits: 16, channels: 1, format: 1, rate: 8000 })
  );
  const data = chunk("data", [0, 0]);

  it.each([
    [
      "too short to be a RIFF file",
      Uint8Array.from([1, 2, 3, 4]),
      "not a RIFF WAVE",
    ],
    [
      "a RIFF file that is not WAVE",
      Uint8Array.from(bytes("RIFF", u32(4), "AVI ")),
      "not a RIFF WAVE",
    ],
    ["a file without a fmt chunk", riff(data), "no fmt chunk"],
    ["a file without a data chunk", riff(goodFmt), "no data chunk"],
    [
      "a fmt chunk that is too short",
      riff(chunk("fmt ", bytes(u16(1), u16(1), u32(8000))), data),
      "fmt chunk is too short",
    ],
    [
      "a compressed format (ADPCM)",
      riff(
        chunk("fmt ", fmtBody({ bits: 4, channels: 1, format: 2, rate: 8000 })),
        data
      ),
      "unsupported format tag 2",
    ],
    [
      "12 bit PCM",
      riff(
        chunk(
          "fmt ",
          fmtBody({ bits: 12, channels: 1, format: 1, rate: 8000 })
        ),
        data
      ),
      "unsupported bit depth 12",
    ],
    [
      "16 bit float",
      riff(
        chunk(
          "fmt ",
          fmtBody({ bits: 16, channels: 1, format: 3, rate: 8000 })
        ),
        data
      ),
      "unsupported bit depth 16",
    ],
    [
      "zero channels",
      riff(
        chunk(
          "fmt ",
          fmtBody({ bits: 16, channels: 0, format: 1, rate: 8000 })
        ),
        data
      ),
      "zero channels",
    ],
  ])("decodeWav rejects %s", (_name, file, message) => {
    expect(() => decodeWav(file)).toThrow(message);
  });

  it("encodeWav rejects an unsupported bit depth and a render without channels", () => {
    expect(() =>
      encodeWav(render(48_000, new Float32Array(4)), { bits: 12 as 16 })
    ).toThrow("bits must be 16, 24 or 32");
    expect(() =>
      encodeWav({ channels: [], events: [], frames: 0, sampleRate: 48_000 })
    ).toThrow("no channels");
  });
});
