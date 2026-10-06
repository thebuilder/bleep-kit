import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePng } from "../../src/tools/png.ts";
import { decodePng, firstDifference, readPngChunks, toHex } from "./helpers.ts";

/*
 * The decoder in helpers.ts is independent of encodePng: it checks every CRC with zlib.crc32 and inflates the IDAT with
 * Node's zlib, which also verifies the zlib header and the Adler-32. The golden bytes below were cross-checked once with
 * Pillow (which reads the image back as the pixels listed) and python's zlib.crc32.
 */

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
  it("writes exactly the bytes the PNG, zlib and deflate specs prescribe for a 2x2 image", () => {
    // row 0: opaque red, half transparent green; row 1: fully transparent blue, an arbitrary RGBA
    const data = Uint8Array.from([
      255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40,
    ]);
    const expected = [
      "89504e470d0a1a0a", // signature
      "0000000d", // IHDR: 13 bytes
      "49484452",
      "00000002", // width
      "00000002", // height
      "08", // bit depth
      "06", // color type 6: RGBA
      "00", // compression method
      "00", // filter method
      "00", // not interlaced
      "72b60d24", // CRC
      "0000001d", // IDAT: 29 bytes
      "49444154",
      "7801", // zlib header
      "01", // final block, stored
      "1200", // LEN 18 = 2 * (1 filter byte + 8 pixel bytes), little endian
      "edff", // NLEN
      "00", // row 0: filter type none
      "ff0000ff00ff0080",
      "00", // row 1: filter type none
      "0000ff000a141e28",
      "36a904e1", // Adler-32 of the 18 bytes
      "33cd048f", // CRC
      "00000000", // IEND: no data
      "49454e44",
      "ae426082", // CRC
    ].join("");
    expect(toHex(encodePng({ data, height: 2, width: 2 }))).toBe(expected);
  });

  it("round trips an image whose size is not a multiple of anything", () => {
    const data = gradient(37, 23);
    const decoded = decodePng(encodePng({ data, height: 23, width: 37 }));
    expect(decoded.width).toBe(37);
    expect(decoded.height).toBe(23);
    expect(decoded.chunks).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(firstDifference(decoded.pixels, data)).toBe(-1);
  });

  it.each([
    // width 1 gives 5 bytes per scanline, so 13107 rows are exactly one full stored block (65535 bytes)
    ["exactly one full stored block", 1, 13_107],
    ["one byte-row more than a full block", 1, 13_108],
    ["a large image over two blocks", 300, 100],
  ])(
    "splits the pixels into stored blocks of at most 65535 bytes: %s",
    (_name, width, height) => {
      const data = gradient(width, height);
      const decoded = decodePng(encodePng({ data, height, width }));
      expect(decoded.pixels.length).toBe(data.length);
      expect(firstDifference(decoded.pixels, data)).toBe(-1);
    }
  );

  it("hands the filtered scanlines to the deflate function and writes its output unchanged as the IDAT", () => {
    const data = gradient(3, 2);
    let received: Uint8Array = new Uint8Array(0);
    const marker = Uint8Array.from([0x78, 0x01, 0xaa, 0xbb]);
    const png = encodePng({ data, height: 2, width: 3 }, (raw) => {
      received = raw.slice();
      return marker;
    });
    // every scanline is a filter byte 0 followed by its 3 pixels
    expect(Array.from(received)).toEqual([
      0,
      ...data.subarray(0, 12),
      0,
      ...data.subarray(12, 24),
    ]);
    const parsed = readPngChunks(png);
    expect(parsed.chunks).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(Array.from(parsed.idat)).toEqual(Array.from(marker));
  });

  it("works with zlib compression the way the CLI uses it, and compresses", () => {
    const flat = new Uint8Array(64 * 64 * 4).fill(7);
    const stored = encodePng({ data: flat, height: 64, width: 64 });
    const deflated = encodePng(
      { data: flat, height: 64, width: 64 },
      (d) => new Uint8Array(deflateSync(d))
    );
    expect(firstDifference(decodePng(deflated).pixels, flat)).toBe(-1);
    expect(deflated.length).toBeLessThan(stored.length / 10);
    const busy = gradient(50, 40);
    const back = decodePng(
      encodePng(
        { data: busy, height: 40, width: 50 },
        (d) => new Uint8Array(deflateSync(d))
      )
    );
    expect(firstDifference(back.pixels, busy)).toBe(-1);
  });

  it.each([
    ["a zero width", 0, 1],
    ["a zero height", 1, 0],
    ["a negative width", -2, 1],
    ["a fractional width", 1.5, 1],
    ["a width that is not a number", Number.NaN, 1],
  ])("rejects %s", (_name, width, height) => {
    expect(() =>
      encodePng({ data: new Uint8Array(16), height, width })
    ).toThrow("bad size");
  });

  it("rejects pixel data shorter than width * height * 4", () => {
    expect(() =>
      encodePng({ data: new Uint8Array(3), height: 1, width: 1 })
    ).toThrow("shorter");
    // 3 x 2 pixels need exactly 24 bytes: one byte less is too short, extra bytes are ignored
    expect(() =>
      encodePng({ data: new Uint8Array(23), height: 2, width: 3 })
    ).toThrow("shorter");
    const padded = decodePng(
      encodePng({ data: new Uint8Array(30).fill(9), height: 2, width: 3 })
    );
    expect(firstDifference(padded.pixels, new Uint8Array(24).fill(9))).toBe(-1);
  });
});
