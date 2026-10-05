import { describe, expect, it } from "vitest";

describe("@bleepkit/studio", () => {
  it("renders the placeholder", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import("../src/main.ts");
    expect(document.querySelector("h1")?.textContent).toBe("Bleepkit Studio");
  });
});
