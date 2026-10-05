/* Shared by the studio's test files: a canvas that records instead of drawing (happy-dom has no 2D context), and the
   waiting helpers the app tests use. */
import { beforeAll } from "vitest";

/** A 2D context that records what is drawn instead of drawing it. */
function recordingContext(log: string[]): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {};
  return new Proxy(target, {
    get(t, key) {
      if (key in t) {
        return t[key];
      }
      if (key === "canvas") {
        return null;
      }
      if (key === "measureText") {
        return () => ({ width: 5 });
      }
      if (key === "createLinearGradient" || key === "createRadialGradient") {
        return () => ({ addColorStop: () => undefined });
      }
      if (key === "getImageData" || key === "createImageData") {
        return (w: number, h: number) => ({
          data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
          height: h,
          width: w,
        });
      }
      return (...args: unknown[]) => {
        log.push(`${String(key)}(${args.length})`);
      };
    },
    set(t, key, value) {
      t[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

export const drawLog: string[] = [];

/** Call once at the top level of a test file that draws. */
export function installCanvasStub(): void {
  beforeAll(() => {
    HTMLCanvasElement.prototype.getContext = function getContext() {
      return recordingContext(drawLog);
    } as unknown as HTMLCanvasElement["getContext"];
    if (typeof globalThis.OffscreenCanvas === "undefined") {
      class FakeOffscreen {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        getContext() {
          return recordingContext(drawLog);
        }
      }
      (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas =
        FakeOffscreen;
    }
  });
}

export const settle = async (ms = 60) => {
  await new Promise((r) => setTimeout(r, ms));
};

export const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!fn() && Date.now() - t0 < ms) {
    // biome-ignore lint/performance/noAwaitInLoops: polling, each wait must finish before the next check
    await settle(20);
  }
  return fn();
};
