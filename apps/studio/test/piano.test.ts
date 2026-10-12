/* The on-screen piano's pointer handling: whatever a pointer does, the note it started ends. Each test is a way the
   old handler lost an end: it kept one note for all pointers, it ignored a move that reported no button, and it never
   heard of a lost capture, a pointer that left, a context menu or a window that lost focus. */
import { describe, expect, it } from "vitest";
import { createPiano } from "../src/ui/piano.ts";
import { installCanvasStub } from "./helpers.ts";

installCanvasStub();

/* C3 to B4: 14 white keys of 24 px on a 336 x 60 canvas. Below the black keys (y 50), C is x 0 to 24, D is 24 to 48,
   E is 48 to 72. */
const C = 48;
const D = 50;
const E = 52;
const X = { [C]: 5, [D]: 30, [E]: 55 };

function mount() {
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () =>
    ({
      bottom: 60,
      height: 60,
      left: 0,
      right: 336,
      top: 0,
      width: 336,
      x: 0,
      y: 0,
    }) as DOMRect;
  canvas.setPointerCapture = () => undefined;
  document.body.append(canvas);
  const downs: number[] = [];
  const ups: number[] = [];
  const piano = createPiano(canvas, {
    hi: 71,
    lo: 48,
    onDown: (n) => downs.push(n),
    onUp: (n) => ups.push(n),
  });
  const fire = (
    type: string,
    note: number,
    init: PointerEventInit & { buttons?: number } = {}
  ) =>
    canvas.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        buttons: type === "pointerdown" || type === "pointermove" ? 1 : 0,
        clientX: X[note as keyof typeof X],
        clientY: 50,
        pointerId: 1,
        ...init,
      })
    );
  return { canvas, downs, fire, piano, ups };
}

describe("the piano's pointer", () => {
  it("lets a note go on pointerup and on pointercancel", () => {
    const { downs, fire, ups } = mount();
    fire("pointerdown", C);
    fire("pointerup", C);
    fire("pointerdown", D);
    fire("pointercancel", D);
    expect(downs).toEqual([C, D]);
    expect(ups).toEqual([C, D]);
  });

  it("lets the old note go when a pointer goes down again without having come up", () => {
    const { downs, fire, ups } = mount();
    fire("pointerdown", C);
    fire("pointerdown", E);
    expect(downs).toEqual([C, E]);
    expect(ups).toEqual([C]);
    fire("pointerup", E);
    expect(ups).toEqual([C, E]);
  });

  it("gives each pointer its own note, and each pointer ends only its own", () => {
    const { downs, fire, ups } = mount();
    fire("pointerdown", C, { pointerId: 1 });
    fire("pointerdown", E, { pointerId: 2 });
    expect(downs).toEqual([C, E]);
    fire("pointerup", C, { pointerId: 1 });
    expect(ups).toEqual([C]);
    fire("pointerup", E, { pointerId: 2 });
    expect(ups).toEqual([C, E]);
  });

  it("follows a drag per pointer: the key it leaves goes, the key it reaches sounds", () => {
    const { downs, fire, ups } = mount();
    fire("pointerdown", C, { pointerId: 1 });
    fire("pointerdown", E, { pointerId: 2 });
    fire("pointermove", D, { pointerId: 1 });
    expect(downs).toEqual([C, E, D]);
    expect(ups).toEqual([C]);
    fire("pointerup", D, { pointerId: 1 });
    fire("pointerup", E, { pointerId: 2 });
    expect(ups).toEqual([C, D, E]);
  });

  it("ends the note of a move that reports no button: the button came up where the page could not hear it", () => {
    const { downs, fire, ups } = mount();
    fire("pointerdown", C);
    fire("pointermove", D, { buttons: 0 });
    expect(ups).toEqual([C]);
    // the pointer is only passing over the keys now
    fire("pointermove", E, { buttons: 0 });
    fire("pointermove", E, { buttons: 1 });
    expect(downs).toEqual([C]);
    expect(ups).toEqual([C]);
  });

  it("ends the note when the pointer capture is lost", () => {
    const { fire, ups } = mount();
    fire("pointerdown", C);
    fire("lostpointercapture", C);
    expect(ups).toEqual([C]);
    // the pointerup that follows a normal release finds nothing left to end
    fire("pointerup", C);
    expect(ups).toEqual([C]);
  });

  it("ends the note when an uncaptured pointer leaves, and keeps it when a captured one does", () => {
    const { canvas, fire, ups } = mount();
    canvas.hasPointerCapture = () => true;
    fire("pointerdown", C);
    fire("pointerleave", C);
    expect(ups).toEqual([]);
    canvas.hasPointerCapture = () => false;
    fire("pointerleave", C);
    expect(ups).toEqual([C]);
  });

  it("still plays when the pointer cannot be captured, and ends the note when it leaves", () => {
    const { canvas, downs, fire, ups } = mount();
    canvas.setPointerCapture = () => {
      throw new Error("No active pointer with the given id is found.");
    };
    canvas.hasPointerCapture = () => false;
    fire("pointerdown", C);
    expect(downs).toEqual([C]);
    fire("pointerleave", C);
    expect(ups).toEqual([C]);
  });

  it("plays only for the main button: a context menu would swallow the other buttons' pointerup", () => {
    const { downs, fire } = mount();
    fire("pointerdown", C, { button: 2, buttons: 2 });
    fire("pointerdown", D, { button: 1, buttons: 4 });
    expect(downs).toEqual([]);
  });

  it("ends every note when the context menu opens or the window loses focus", () => {
    const { fire, ups, canvas } = mount();
    fire("pointerdown", C, { pointerId: 1 });
    fire("pointerdown", E, { pointerId: 2 });
    canvas.dispatchEvent(new Event("contextmenu", { bubbles: true }));
    expect(ups.toSorted()).toEqual([C, E]);
    ups.length = 0;
    fire("pointerdown", D);
    window.dispatchEvent(new Event("blur"));
    expect(ups).toEqual([D]);
  });

  it("ends the held note and stops listening when it is disposed (the octave changed under the mouse)", () => {
    const { downs, fire, piano, ups } = mount();
    fire("pointerdown", C);
    piano.dispose();
    expect(ups).toEqual([C]);
    fire("pointerdown", D);
    window.dispatchEvent(new Event("blur"));
    expect(downs).toEqual([C]);
    expect(ups).toEqual([C]);
  });
});
