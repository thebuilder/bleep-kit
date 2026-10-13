/* The license badge: CC0 (no credit needed) or CC BY (credit required), the same pill in the Freesound list, the
   sidebar and the sample editor. */
import { h } from "../lib/dom.ts";

export type BadgeLicense = "CC0" | "CC BY";

export function licenseBadge(license: BadgeLicense): HTMLElement {
  const by = license === "CC BY";
  return h(
    "span",
    {
      class: `lic ${by ? "lic-by" : "lic-cc0"}`,
      title: by
        ? "Creative Commons Attribution: credit required (listed in CREDITS.txt on export)"
        : "Creative Commons 0: no credit needed",
    },
    license
  );
}
