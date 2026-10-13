/* The tracker's clipboard. The block lives in a module-level variable, so it survives switching patterns and songs
   (the song editor is mounted afresh each time). Every copy also writes the block as text to the system clipboard when
   the browser has one, and a paste can read text from the system clipboard (the browser hands it over with the paste
   event, so there is never a permission prompt). Every failure of the clipboard API is swallowed: the internal block
   still works. */
import { type Block, blockToText, textToBlock } from "./tracker-clip.ts";

interface Held {
  block: Block;
  /** False once something else may have been copied: another copy in this page, or the window lost the focus. */
  fresh: boolean;
  text: string;
}

let held: Held | null = null;
let watching = false;

/** Something else may now be on the system clipboard, so the next paste has to look at its text. */
function goStale(): void {
  if (held) {
    held.fresh = false;
  }
}

function watchForeignCopies(): void {
  if (watching || typeof document === "undefined") {
    return;
  }
  watching = true;
  // the tracker's own copy never fires these (it writes with the clipboard API); any other copy in the page does
  document.addEventListener("copy", goStale, true);
  document.addEventListener("cut", goStale, true);
  window.addEventListener("blur", goStale);
}

/** Write `text` to the system clipboard, quietly: no clipboard, no permission, a rejected promise all do nothing. */
function writeSystem(text: string): void {
  try {
    navigator.clipboard?.writeText?.(text)?.catch(() => undefined);
  } catch {
    // the clipboard API is not there or refused
  }
}

/** Keep `block` as the clipboard and offer it to the system as text (`instIds` numbers the instruments in it). */
export function holdBlock(block: Block, instIds: readonly string[]): void {
  const text = blockToText(block, instIds);
  held = { block, fresh: true, text };
  watchForeignCopies();
  writeSystem(text);
}

/** The block, when nothing has been copied elsewhere since: a paste can use it without asking the system. */
export function freshBlock(): Block | null {
  return held?.fresh ? held.block : null;
}

/** The block, fresh or not. */
export function heldBlock(): Block | null {
  return held?.block ?? null;
}

/** What a paste puts down, given the text the system clipboard holds (null when it could not be read): the block that
 *  was copied here when the text is empty, is what was written for it, or is not a block; else the block in the text. */
export function resolvePaste(
  systemText: string | null | undefined,
  instIds: readonly string[]
): Block | null {
  const text = (systemText ?? "").trim();
  if (held && (text === "" || text === held.text.trim())) {
    return held.block;
  }
  return (text ? textToBlock(text, instIds) : null) ?? held?.block ?? null;
}

/** Forget the clipboard (for tests). */
export function clearClipboard(): void {
  held = null;
}
