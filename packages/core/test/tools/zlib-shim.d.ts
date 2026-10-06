/* The core tsconfig has no Node types (see ../node-shim.d.ts). The PNG tests use Node's zlib as an independent
   implementation of CRC-32 and deflate/inflate, so these three functions are declared here. At runtime they return Buffers. */

declare module "node:zlib" {
  export function crc32(data: Uint8Array): number;
  export function deflateSync(data: Uint8Array): Uint8Array;
  export function inflateSync(data: Uint8Array): Uint8Array;
}
