// biome-ignore-all lint/suspicious/noBitwiseOperators: the Ogg flag bits and MP3 header fields are bit fields
import { describe, expect, it } from "vitest";
import {
  encodeMp3,
  encodeOgg,
  MP3_ENCODER_DELAY,
} from "../../src/tools/encode.ts";
import { render, sine } from "./helpers.ts";

const SR = 48_000;
const tone = () => render(SR, sine(SR, 1, 440, 0.5), sine(SR, 1, 660, 0.4));

function ascii(bytes: Uint8Array, at: number, len: number): string {
  return String.fromCharCode(...Array.from(bytes.subarray(at, at + len)));
}

/** Ogg pages: capture pattern "OggS" at each page start, following the segment table to the next page. */
function oggPages(
  bytes: Uint8Array
): { header: number; serial: number; flags: number; granule: number }[] {
  const pages: {
    header: number;
    serial: number;
    flags: number;
    granule: number;
  }[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at + 27 <= bytes.length) {
    if (ascii(bytes, at, 4) !== "OggS") {
      throw new Error(`no OggS at ${at}`);
    }
    const segments = bytes[at + 26] ?? 0;
    let body = 0;
    for (let i = 0; i < segments; i += 1) {
      body += bytes[at + 27 + i] ?? 0;
    }
    pages.push({
      flags: bytes[at + 5] ?? 0,
      granule: Number(view.getBigUint64(at + 6, true)),
      header: at,
      serial: view.getUint32(at + 14, true),
    });
    at += 27 + segments + body;
  }
  expect(at).toBe(bytes.length);
  return pages;
}

describe("encodeOgg", () => {
  it("writes a well formed Ogg Vorbis stream", async () => {
    const bytes = await encodeOgg(tone());
    expect(ascii(bytes, 0, 4)).toBe("OggS");
    const pages = oggPages(bytes);
    expect(pages.length).toBeGreaterThan(3);
    // first page: beginning of stream, carrying the vorbis identification header
    expect((pages[0]?.flags ?? 0) & 2).toBe(2);
    expect(ascii(bytes, 29, 6)).toBe("vorbis");
    // last page: end of stream, granule position equal to the number of frames (gapless)
    expect((pages.at(-1)?.flags ?? 0) & 4).toBe(4);
    expect(pages.at(-1)?.granule).toBe(SR);
    // one logical stream
    expect(new Set(pages.map((p) => p.serial)).size).toBe(1);
  });

  it("makes plausible sizes for the quality", async () => {
    const mid = await encodeOgg(tone());
    expect(mid.length).toBeGreaterThan(4000);
    expect(mid.length).toBeLessThan(30_000);
    const low = await encodeOgg(tone(), { quality: 0 });
    const high = await encodeOgg(tone(), { quality: 9 });
    expect(low.length).toBeLessThan(mid.length);
    expect(high.length).toBeGreaterThan(mid.length);
  });

  it("gives identical bytes for identical input", async () => {
    const a = await encodeOgg(tone());
    const b = await encodeOgg(tone());
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("gives a different stream serial only when asked", async () => {
    const a = oggPages(await encodeOgg(tone()))[0]?.serial;
    const b = oggPages(await encodeOgg(tone(), { serial: 99 }))[0]?.serial;
    expect(a).toBe(0x42_4c_45_50);
    expect(b).toBe(99);
  });

  it("encodes mono, other rates and out of range samples", async () => {
    const left = sine(44_100, 0.5, 300, 1.5);
    const bytes = await encodeOgg({
      channels: [left],
      events: [],
      frames: left.length,
      sampleRate: 44_100,
    });
    expect(ascii(bytes, 0, 4)).toBe("OggS");
    expect(oggPages(bytes).at(-1)?.granule).toBe(left.length);
  });

  it("encodes an empty render and rejects more than two channels", async () => {
    const empty = await encodeOgg(render(SR, new Float32Array(0)));
    expect(ascii(empty, 0, 4)).toBe("OggS");
    const l = new Float32Array(10);
    await expect(
      encodeOgg({ channels: [l, l, l], events: [], frames: 10, sampleRate: SR })
    ).rejects.toThrow("1 or 2 channels");
  });
});

describe("encodeMp3", () => {
  it("writes MPEG audio frames at the bitrate", async () => {
    const bytes = await encodeMp3(tone());
    // frame sync: 11 set bits, then MPEG 1 (version bits 11) layer III (bits 01)
    expect(bytes[0]).toBe(0xff);
    expect((bytes[1] ?? 0) & 0xfe).toBe(0xfa);
    // bitrate index 1010 is 160 kbps for MPEG 1 layer III, sample rate index 01 is 48 kHz
    expect((bytes[2] ?? 0) >> 4).toBe(0b1010);
    expect(((bytes[2] ?? 0) >> 2) & 3).toBe(1);
    // 160 kbps for about a second plus encoder padding
    expect(bytes.length).toBeGreaterThan(18_000);
    expect(bytes.length).toBeLessThan(23_000);
  });

  it("scales with the bitrate and snaps to a valid one", async () => {
    const small = await encodeMp3(tone(), { bitrate: 64 });
    const big = await encodeMp3(tone(), { bitrate: 320 });
    expect(big.length).toBeGreaterThan(small.length * 3);
    const snapped = await encodeMp3(tone(), { bitrate: 150 });
    expect(Array.from(snapped)).toEqual(
      Array.from(await encodeMp3(tone(), { bitrate: 160 }))
    );
  });

  it("gives identical bytes for identical input", async () => {
    const a = await encodeMp3(tone());
    const b = await encodeMp3(tone());
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("keeps the source sample rate when LAME supports it", async () => {
    const left = sine(44_100, 0.5, 440, 0.5);
    const bytes = await encodeMp3(
      {
        channels: [left, left],
        events: [],
        frames: left.length,
        sampleRate: 44_100,
      },
      { bitrate: 64 }
    );
    expect(((bytes[2] ?? 0) >> 2) & 3).toBe(0); // 44.1 kHz
  });

  it("encodes mono, an unsupported rate and an empty render, and rejects three channels", async () => {
    const left = sine(SR, 0.3, 440, 0.5);
    const mono = await encodeMp3({
      channels: [left],
      events: [],
      frames: left.length,
      sampleRate: SR,
    });
    expect((mono[3] ?? 0) >> 6).toBe(0b11); // channel mode: mono
    const hi = sine(96_000, 0.3, 440, 0.5);
    const resampled = await encodeMp3({
      channels: [hi, hi],
      events: [],
      frames: hi.length,
      sampleRate: 96_000,
    });
    expect(resampled[0]).toBe(0xff);
    const empty = await encodeMp3(render(SR, new Float32Array(0)));
    expect(empty).toBeInstanceOf(Uint8Array);
    const l = new Float32Array(10);
    await expect(
      encodeMp3({ channels: [l, l, l], events: [], frames: 10, sampleRate: SR })
    ).rejects.toThrow("1 or 2 channels");
  });

  it("documents the encoder delay", () => {
    expect(MP3_ENCODER_DELAY).toBe(1105);
  });
});
