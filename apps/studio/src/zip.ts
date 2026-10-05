/* A tiny zip writer (stored entries, no compression) and reader, for exporting a project and importing one.
   The reader also takes deflated entries when the browser has DecompressionStream. */

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xff_ff_ff_ff;
  for (const byte of data) {
    c = (TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xff_ff_ff_ff) >>> 0;
}

export interface ZipEntry {
  data: Uint8Array;
  path: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** DOS time and date for a Date (zip stores local time with 2 second resolution). */
function dosStamp(d: Date): { time: number; date: number } {
  return {
    date:
      ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

export function writeZip(
  entries: readonly ZipEntry[],
  when: Date = new Date()
): Uint8Array {
  const { time, date } = dosStamp(when);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path);
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04_03_4b_50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x08_00, true); // utf-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, e.data);
    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02_01_4b_50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x08_00, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    central.push(cen);
    offset += local.length + e.data.length;
  }
  const cenSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06_05_4b_50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cenSize + 22);
  let p = 0;
  for (const chunk of [...parts, ...central, end]) {
    out.set(chunk, p);
    p += chunk.length;
  }
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "This browser cannot read compressed zip files. Export the folder as a stored zip, or drop the files."
    );
  }
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (
    let i = bytes.length - 22;
    i >= Math.max(0, bytes.length - 65_557);
    i -= 1
  ) {
    if (v.getUint32(i, true) === 0x06_05_4b_50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("That file is not a zip archive.");
  }
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const pending: Promise<ZipEntry>[] = [];
  for (let i = 0; i < count; i += 1) {
    if (v.getUint32(p, true) !== 0x02_01_4b_50) {
      throw new Error("The zip directory is damaged.");
    }
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    const lho = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) {
      continue;
    }
    const lnlen = v.getUint16(lho + 26, true);
    const lxlen = v.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lxlen;
    const raw = bytes.subarray(start, start + csize);
    pending.push(
      (method === 0 ? Promise.resolve(raw.slice()) : inflateRaw(raw)).then(
        (data) => ({ data, path: name })
      )
    );
  }
  const entries = await Promise.all(pending);
  return entries;
}
