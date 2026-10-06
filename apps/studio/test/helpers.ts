/* Shared by the studio's test files: a canvas that records instead of drawing (happy-dom has no 2D context), and the
   waiting helpers the app tests use. */
import { beforeAll } from "vitest";

/** One filled rectangle, with the fill style it was drawn in. */
export interface FilledRect {
  h: number;
  style: string;
  w: number;
  x: number;
  y: number;
}

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
      if (key === "fillRect") {
        return (x: number, y: number, w: number, h: number) => {
          log.push("fillRect(4)");
          filledRects.push({ h, style: String(t.fillStyle), w, x, y });
          if (filledRects.length > 50_000) {
            // the animation loops draw all the time; keep only the recent past
            filledRects.splice(0, 25_000);
          }
        };
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
/** Every rectangle filled on a recording canvas since the test emptied this list (`filledRects.length = 0`). */
export const filledRects: FilledRect[] = [];

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

/** The control of the inspector row whose label reads `label` (range, select, checkbox or text input). `nth` picks
    among rows that share a label ("Volume" appears for the song and for the channel). */
export function field<T extends HTMLElement = HTMLInputElement>(
  root: ParentNode,
  label: string,
  nth = 0
): T {
  let seen = 0;
  for (const row of root.querySelectorAll(".fld")) {
    if (row.querySelector("label")?.textContent === label) {
      const control = row.querySelector<T>(
        "input[type=range], select, input[type=checkbox], input.wide"
      );
      if (control) {
        if (seen === nth) {
          return control;
        }
        seen += 1;
      }
    }
  }
  throw new Error(`no field labelled "${label}" (number ${nth})`);
}

/** Move a range input and tell the page, as dragging it does. */
export function setRange(input: HTMLInputElement, value: number): void {
  input.value = String(value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
