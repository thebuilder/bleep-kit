import { describe, expect, it } from "vitest";
import { encodePng } from "../../src/tools/png.ts";
import { adler32, crc32, decodeStoredPng } from "./helpers.ts";

function gradient(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = x % 256;
      data[i + 1] = y % 256;
      data[i + 2] = (x * 7 + y * 3) % 256;
      data[i + 3] = 255;
    }
  }
  return data;
}

describe("encodePng", () => {
  it("writes stored blocks that a hand parser decodes to the same pixels", () => {
    const data = gradient(37, 23);
    const png = encodePng({ data, height: 23, width: 37 });
    const decoded = decodeStoredPng(png);
    expect(decoded.width).toBe(37);
    expect(decoded.height).toBe(23);
    expect(decoded.chunks).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(Array.from(decoded.pixels)).toEqual(Array.from(data));
  });

  it("splits large images over several stored blocks", () => {
    const data = gradient(300, 100); // 120 KB of pixels: more than one 64 KB block
    const decoded = decodeStoredPng(
      encodePng({ data, height: 100, width: 300 })
    );
    expect(decoded.pixels.length).toBe(data.length);
    expect(Array.from(decoded.pixels.subarray(0, 4000))).toEqual(
      Array.from(data.subarray(0, 4000))
    );
    expect(Array.from(decoded.pixels.subarray(data.length - 4000))).toEqual(
      Array.from(data.subarray(data.length - 4000))
    );
  });

  it("uses the deflate function it is given, and wraps nothing around its output", () => {
    const data = gradient(8, 8);
    let seen = 0;
    const marker = Uint8Array.from([0x78, 0x01, 0xaa, 0xbb]);
    const png = encodePng({ data, height: 8, width: 8 }, (raw) => {
      seen = raw.length;
      return marker;
    });
    expect(seen).toBe((8 * 4 + 1) * 8);
    // the IDAT body is exactly what deflate returned
    const view = new DataView(png.buffer);
    const idatAt = 8 + 12 + 13;
    expect(view.getUint32(idatAt, false)).toBe(4);
    expect(Array.from(png.subarray(idatAt + 8, idatAt + 12))).toEqual(
      Array.from(marker)
    );
  });

  it("writes the signature, IHDR fields and valid chunk CRCs", () => {
    const png = encodePng({ data: gradient(5, 4), height: 4, width: 5 });
    expect(Array.from(png.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const view = new DataView(png.buffer);
    expect(view.getUint32(8, false)).toBe(13);
    expect(view.getUint32(16, false)).toBe(5);
    expect(view.getUint32(20, false)).toBe(4);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
    // IEND is the last 12 bytes with the well known CRC
    expect(view.getUint32(png.length - 4, false)).toBe(0xae_42_60_82);
  });

  it("matches the reference checksums", () => {
    const text = Uint8Array.from(
      "123456789".split("").map((c) => c.charCodeAt(0))
    );
    expect(crc32(text)).toBe(0xcb_f4_39_26);
    expect(adler32(text)).toBe(0x09_1e_01_de);
  });

  it("rejects a bad size or short data", () => {
    expect(() =>
      encodePng({ data: new Uint8Array(4), height: 1, width: 0 })
    ).toThrow("bad size");
    expect(() =>
      encodePng({ data: new Uint8Array(3), height: 1, width: 1 })
    ).toThrow("shorter");
  });

  it("encodes a one pixel image", () => {
    const decoded = decodeStoredPng(
      encodePng({ data: Uint8Array.from([1, 2, 3, 255]), height: 1, width: 1 })
    );
    expect(Array.from(decoded.pixels)).toEqual([1, 2, 3, 255]);
  });
});
