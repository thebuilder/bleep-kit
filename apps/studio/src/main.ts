/* Entry point: boot the studio into #app. */
import { boot } from "./shell.ts";

const root = document.getElementById("app");
if (root) {
  boot(root).catch((err: unknown) => {
    console.error(err);
    root.textContent = `The studio could not start: ${(err as Error).message}`;
  });
}
