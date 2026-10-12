/* A rendered analysis picture as base64 PNG for the model. The browser's own encoder compresses it (a 900 pixel
   waveform is a few kilobytes that way); where there is no canvas the core encoder writes a valid, uncompressed PNG. */
import { encodePng, type PixelImage } from "../lib/core.ts";

const CHUNK = 0x80_00;

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(text);
}

async function viaCanvas(img: PixelImage): Promise<Uint8Array | null> {
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof ImageData === "undefined") {
    return null;
  }
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(img.data), img.width, img.height),
    0,
    0
  );
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png")
  );
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** The picture as base64 PNG bytes, compressed when the browser can. */
export async function pngBase64(img: PixelImage): Promise<string> {
  let bytes: Uint8Array | null = null;
  try {
    bytes = await viaCanvas(img);
  } catch {
    bytes = null;
  }
  return toBase64(bytes ?? encodePng(img));
}
