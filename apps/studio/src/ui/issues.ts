/* Normalize issues, spoken plainly: the path becomes a field name, errors are red, warnings amber. */
import type { Issue } from "../lib/contract.ts";
import { h } from "../lib/dom.ts";

/** "frequency.start" becomes "Frequency / start"; "ops[1].level" becomes "Ops 2 / level". */
export function fieldLabel(path: string): string {
  const parts = path
    .replace(/\[(\d+)\]/g, (_, n: string) => `.${Number(n) + 1}`)
    .split(".")
    .filter(Boolean);
  if (parts.length === 0) {
    return "Document";
  }
  return parts
    .map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(" / ");
}

export function issuesBox(issues: readonly Issue[]): HTMLElement | null {
  if (issues.length === 0) {
    return null;
  }
  const errors = issues.some((i) => i.severity === "error");
  const box = h("div", {
    class: `issues${errors ? "" : " warn"}`,
    role: "status",
  });
  for (const i of issues.slice(0, 8)) {
    const row = h("div", {});
    row.append(
      h("span", { class: "path" }, fieldLabel(i.path)),
      ` ${i.message}`
    );
    box.append(row);
  }
  if (issues.length > 8) {
    box.append(h("div", {}, `and ${issues.length - 8} more`));
  }
  return box;
}
