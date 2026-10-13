/* What the Freesound panel offers to click: the subcategories of "Instrument samples" (from the Broad Sound Taxonomy,
   server/freesound/protocol.ts) and tags worth trying for each. The tags are suggestions for a retro game's sound
   kit, not a list read from Freesound: a tag with no results just shows an empty list. */
import type { SubcategoryId } from "../../server/freesound/protocol.ts";

export interface TagChip {
  label: string;
  /** The tag as Freesound writes it: lowercase, words joined by dashes. */
  tag: string;
}

const tag = (t: string, label = t): TagChip => ({ label, tag: t });

const COMMON: TagChip[] = [
  tag("kick"),
  tag("snare"),
  tag("bass"),
  tag("pluck"),
  tag("stab"),
  tag("lead"),
  tag("pad"),
  tag("chiptune"),
  tag("8-bit"),
  tag("amiga"),
];

const BY_SUB: Record<SubcategoryId, TagChip[]> = {
  keys: [
    tag("piano"),
    tag("organ"),
    tag("chord"),
    tag("stab"),
    tag("pad"),
    tag("808"),
    tag("chiptune"),
    tag("8-bit"),
  ],
  other: [
    tag("choir"),
    tag("vocal"),
    tag("orchestra-hit", "orchestra hit"),
    tag("chiptune"),
    tag("8-bit"),
    tag("amiga"),
  ],
  percussion: [
    tag("kick"),
    tag("snare"),
    tag("clap"),
    tag("hihat"),
    tag("tom"),
    tag("cymbal"),
    tag("808"),
    tag("909"),
    tag("chiptune"),
    tag("8-bit"),
  ],
  string: [
    tag("pluck"),
    tag("bass"),
    tag("stab"),
    tag("chord"),
    tag("harp"),
    tag("guitar"),
    tag("orchestra-hit", "orchestra hit"),
  ],
  synth: [
    tag("bass"),
    tag("808"),
    tag("lead"),
    tag("pad"),
    tag("stab"),
    tag("chord"),
    tag("pluck"),
    tag("orchestra-hit", "orchestra hit"),
    tag("choir"),
    tag("vocal"),
    tag("chiptune"),
    tag("8-bit"),
    tag("amiga"),
  ],
  wind: [
    tag("flute"),
    tag("whistle"),
    tag("pad"),
    tag("choir"),
    tag("vocal"),
    tag("chiptune"),
  ],
};

/** The tag chips for a subcategory, or for the whole category when none is chosen. */
export function tagChipsFor(sub: SubcategoryId | null): TagChip[] {
  return sub ? BY_SUB[sub] : COMMON;
}
