import { describe, expect, it } from "vitest";
import {
  encodeMp3,
  encodeOgg,
  MP3_ENCODER_DELAY,
} from "../../src/tools/encode.ts";
import type { RenderResult } from "../../src/types.ts";
import { render, sine } from "./helpers.ts";

/*
 * There is no decoder in the test environment, so these tests check the containers against their specifications:
 * Ogg pages (capture pattern, flags, granule position, page CRC, the Vorbis identification header) and MPEG audio
 * frames (header fields from ISO 11172-3 and the frame length they imply, which must tile the stream exactly).
 * Decoding with ffmpeg was done once by hand: L/R order and pitch are right in both formats, the Ogg is gapless
 * (a click at frame 10000 decodes at frame 10000) and the MP3 click decodes 1105 frames late.
 */

const SR = 48_000;
const tone = () => render(SR, sine(SR, 1, 440, 0.5), sine(SR, 1, 660, 0.4));

const mono = (plane: Float32Array, sampleRate: number): RenderResult => ({
  channels: [plane],
  events: [],
  frames: plane.length,
  sampleRate,
});

function ascii(bytes: Uint8Array, at: number, len: number): string {
  return String.fromCharCode(...Array.from(bytes.subarray(at, at + len)));
}

/** The Ogg page checksum: CRC-32 with polynomial 0x04c11db7, no reflection, zero start value and no final xor. */
function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 24;
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 0x80_00_00_00 ? (crc << 1) ^ 0x04_c1_1d_b7 : crc << 1;
    }
  }
  return crc >>> 0;
}

interface OggPage {
  flags: number;
  granule: number;
  header: number;
  length: number;
  serial: number;
}

/** Walk the Ogg pages, following each segment table to the next page, and check every page's CRC. The pages must end exactly at the end of the stream. */
function oggPages(bytes: Uint8Array): OggPage[] {
  const pages: OggPage[] = [];
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
    const length = 27 + segments + body;
    const page = bytes.slice(at, at + length);
    new DataView(page.buffer).setUint32(22, 0, true); // the CRC is computed with its own field zeroed
    expect(view.getUint32(at + 22, true), `CRC of the page at ${at}`).toBe(
      oggCrc(page)
    );
    pages.push({
      flags: bytes[at + 5] ?? 0,
      granule: Number(view.getBigUint64(at + 6, true)),
      header: at,
      length,
      serial: view.getUint32(at + 14, true),
    });
    at += length;
  }
  expect(at).toBe(bytes.length);
  return pages;
}

/** The fields of the Vorbis identification header, which sits in the body of the first page. */
function vorbisId(bytes: Uint8Array): {
  channels: number;
  sampleRate: number;
  version: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const body = 27 + (bytes[26] ?? 0);
  expect(bytes[body]).toBe(1); // packet type: identification
  expect(ascii(bytes, body + 1, 6)).toBe("vorbis");
  return {
    channels: view.getUint8(body + 11),
    sampleRate: view.getUint32(body + 12, true),
    version: view.getUint32(body + 7, true),
  };
}

const MPEG1_L3_KBPS = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const MPEG1_RATES = [44_100, 48_000, 32_000];

interface Mp3Frame {
  bitrateKbps: number;
  channelMode: number;
  length: number;
  sampleRate: number;
}

/** Walk the MPEG audio frames. Each header must be MPEG 1 layer III with a sync word, and its length (144 * bitrate / sample rate, plus the padding bit) must lead exactly to the next header and the last one to the end of the stream. */
function mp3Frames(bytes: Uint8Array): Mp3Frame[] {
  const frames: Mp3Frame[] = [];
  let at = 0;
  while (at < bytes.length) {
    const h1 = bytes[at + 1] ?? 0;
    expect(bytes[at], `sync byte at ${at}`).toBe(0xff);
    expect(h1 & 0xfe, `MPEG 1 layer III at ${at}`).toBe(0xfa);
    const h2 = bytes[at + 2] ?? 0;
    const bitrateKbps = MPEG1_L3_KBPS[h2 >> 4] ?? 0;
    const sampleRate = MPEG1_RATES[(h2 >> 2) & 3] ?? 0;
    expect(bitrateKbps).toBeGreaterThan(0);
    expect(sampleRate).toBeGreaterThan(0);
    const padding = (h2 >> 1) & 1;
    const length =
      Math.floor((144 * bitrateKbps * 1000) / sampleRate) + padding;
    frames.push({
      bitrateKbps,
      channelMode: (bytes[at + 3] ?? 0) >> 6,
      length,
      sampleRate,
    });
    at += length;
  }
  expect(at).toBe(bytes.length);
  return frames;
}

describe("encodeOgg", () => {
  it("writes a well formed, gapless Ogg Vorbis stream", async () => {
    const bytes = await encodeOgg(tone());
    const pages = oggPages(bytes);
    expect(pages.length).toBeGreaterThan(3);
    // first page: beginning of stream, carrying the identification header; last page: end of stream
    expect(pages[0]?.flags).toBe(0x02);
    expect(vorbisId(bytes).version).toBe(0);
    expect((pages.at(-1)?.flags ?? 0) & 0x04).toBe(0x04);
    // gapless: the last granule position is the number of frames, so decoders drop nothing and add nothing
    expect(pages.at(-1)?.granule).toBe(SR);
    expect(new Set(pages.map((p) => p.serial)).size).toBe(1);
  });

  it("tells the decoder the real channel count and sample rate", async () => {
    expect(vorbisId(await encodeOgg(tone()))).toMatchObject({
      channels: 2,
      sampleRate: 48_000,
    });
    const left = sine(44_100, 0.5, 300, 0.5);
    const bytes = await encodeOgg(mono(left, 44_100));
    expect(vorbisId(bytes)).toMatchObject({ channels: 1, sampleRate: 44_100 });
    expect(oggPages(bytes).at(-1)?.granule).toBe(left.length);
  });

  it("makes smaller files for lower quality, and clamps the quality to -1..10", async () => {
    const q = async (quality: number) =>
      (await encodeOgg(tone(), { quality })).length;
    const sizes = [
      await q(-1),
      await q(0),
      await q(6),
      await q(9),
      await q(10),
    ];
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(new Set(sizes).size).toBe(sizes.length);
    expect(await q(99)).toBe(sizes[4]);
    expect(await q(-5)).toBe(sizes[0]);
    // the default is quality 6
    expect((await encodeOgg(tone())).length).toBe(sizes[2]);
    // a second of two sines at quality 6 is a few kilobytes, nowhere near raw PCM (384000 bytes)
    expect(sizes[2]).toBeGreaterThan(4000);
    expect(sizes[2]).toBeLessThan(30_000);
  });

  it("encodes samples beyond full scale as full scale", async () => {
    const loud = sine(SR, 0.5, 300, 1.5);
    const clipped = loud.map((v) => Math.max(-1, Math.min(1, v)));
    expect(Array.from(await encodeOgg(mono(loud, SR)))).toEqual(
      Array.from(await encodeOgg(mono(clipped, SR)))
    );
  });

  it("gives identical bytes for identical input, with a pinned stream serial unless one is given", async () => {
    const a = await encodeOgg(tone());
    const b = await encodeOgg(tone());
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(oggPages(a)[0]?.serial).toBe(0x42_4c_45_50);
    expect(oggPages(await encodeOgg(tone(), { serial: 99 }))[0]?.serial).toBe(
      99
    );
  });

  it("encodes an empty render as a valid stream with zero frames", async () => {
    const pages = oggPages(await encodeOgg(render(SR, new Float32Array(0))));
    expect(pages[0]?.flags).toBe(0x02);
    expect((pages.at(-1)?.flags ?? 0) & 0x04).toBe(0x04);
    expect(pages.at(-1)?.granule).toBe(0);
  });

  it.each([0, 3])("rejects %i channels", async (count) => {
    const l = new Float32Array(10);
    await expect(
      encodeOgg({
        channels: Array.from({ length: count }, () => l),
        events: [],
        frames: 10,
        sampleRate: SR,
      })
    ).rejects.toThrow("1 or 2 channels");
  });
});

describe("encodeMp3", () => {
  it("writes a stream of MPEG 1 layer III frames at 160 kbps and the source sample rate that tile it exactly", async () => {
    const frames = mp3Frames(await encodeMp3(tone()));
    expect(frames.every((f) => f.bitrateKbps === 160)).toBe(true);
    expect(frames.every((f) => f.sampleRate === 48_000)).toBe(true);
    // 1152 samples per frame: a second of audio plus the 1105 frame encoder delay needs 43 frames, and the
    // encoder adds at most one frame of padding
    expect(frames.length).toBeGreaterThanOrEqual(43);
    expect(frames.length).toBeLessThanOrEqual(44);
    expect(frames.every((f) => f.channelMode !== 3)).toBe(true);
  });

  it.each([
    [64, 64],
    [150, 160], // snaps to the nearest bitrate LAME has
    [320, 320],
    [1000, 320],
    [1, 32], // MPEG 1 layer III has nothing below 32 kbps, which is what a 48 kHz stream uses
  ])("encodes a requested %i kbps as %i kbps", async (requested, actual) => {
    const bytes = await encodeMp3(tone(), { bitrate: requested });
    expect(mp3Frames(bytes).every((f) => f.bitrateKbps === actual)).toBe(true);
    // constant bitrate: about actual / 8 kilobytes per second of audio
    expect(bytes.length).toBeGreaterThan(actual * 125 * 0.95);
    expect(bytes.length).toBeLessThan(actual * 125 * 1.1);
  });

  it("gives identical bytes for identical input", async () => {
    const a = await encodeMp3(tone());
    const b = await encodeMp3(tone());
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("keeps 44.1 kHz and 32 kHz as they are and resamples a rate MP3 does not have", async () => {
    const at = async (rate: number, bitrate: number) => {
      const left = sine(rate, 0.5, 440, 0.5);
      return mp3Frames(
        await encodeMp3(
          {
            channels: [left, left],
            events: [],
            frames: left.length,
            sampleRate: rate,
          },
          { bitrate }
        )
      );
    };
    expect((await at(44_100, 64)).every((f) => f.sampleRate === 44_100)).toBe(
      true
    );
    expect((await at(32_000, 64)).every((f) => f.sampleRate === 32_000)).toBe(
      true
    );
    // 96 kHz is not an MP3 rate: it is encoded at the nearest one, 48 kHz, and keeps its duration
    const hi = await at(96_000, 128);
    expect(hi.every((f) => f.sampleRate === 48_000)).toBe(true);
    const seconds = (hi.length * 1152) / 48_000;
    expect(seconds).toBeGreaterThanOrEqual(0.5);
    expect(seconds).toBeLessThan(0.5 + (3 * 1152) / 48_000);
  });

  it("writes mono as channel mode single channel and stereo as anything else", async () => {
    const left = sine(SR, 0.3, 440, 0.5);
    const frames = mp3Frames(await encodeMp3(mono(left, SR)));
    expect(frames.every((f) => f.channelMode === 3)).toBe(true);
  });

  it("encodes samples beyond full scale as full scale", async () => {
    const loud = sine(SR, 0.5, 300, 1.5);
    const clipped = loud.map((v) => Math.max(-1, Math.min(1, v)));
    expect(Array.from(await encodeMp3(mono(loud, SR)))).toEqual(
      Array.from(await encodeMp3(mono(clipped, SR)))
    );
  });

  it("encodes an empty render as a valid, possibly empty, frame chain", async () => {
    const bytes = await encodeMp3(render(SR, new Float32Array(0)));
    expect(mp3Frames(bytes).length).toBeLessThanOrEqual(2);
  });

  it.each([0, 3])("rejects %i channels", async (count) => {
    const l = new Float32Array(10);
    await expect(
      encodeMp3({
        channels: Array.from({ length: count }, () => l),
        events: [],
        frames: 10,
        sampleRate: SR,
      })
    ).rejects.toThrow("1 or 2 channels");
  });
});

describe("MP3_ENCODER_DELAY", () => {
  // Measured with ffmpeg: a click at frame 10000 of an encodeMp3 stream decodes at frame 11105 (peak at 11106 for a
  // click whose first sample is 0), because the stream carries no LAME tag that would let a decoder compensate.
  // The CLI shifts the manifest loop points by this value, so it has to be the delay the encoder really adds.
  it("is the 1105 frames the encoder adds, which is what the export shifts MP3 loop points by", () => {
    expect(MP3_ENCODER_DELAY).toBe(1105);
  });
});
