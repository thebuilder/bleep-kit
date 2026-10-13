/* The Freesound sample browser (src/freesound) mounted on its own: searching, the license rules the list shows, hearing
   a row the moment it is selected, the keys, and what a studio without a server or without a key says. The studio's own
   /api/freesound routes are the real handler, answered from the fixtures (server/freesound/fixtures.ts), so nothing
   leaves the machine; the engine is a fake that records the samples it is asked to play. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_KEY } from "../server/freesound/fixtures.ts";
import { clearSearchCache, type FreesoundSound } from "../src/freesound/api.ts";
import { createFreesoundPanel, type Panel } from "../src/freesound/panel.ts";
import { PreviewPlayer } from "../src/freesound/preview.ts";
import type { UserSample } from "../src/lib/contract.ts";
import { ORIGIN, serve } from "./freesound-helpers.ts";
import { settle, until } from "./helpers.ts";

interface Rig {
  played: UserSample[];
  stopped: { count: number };
}

/** A player whose decoder turns any bytes into a short sine, and whose engine records what it plays. */
function rig(): Rig & { player: PreviewPlayer } {
  const played: UserSample[] = [];
  const stopped = { count: 0 };
  const player = new PreviewPlayer({
    decode: () =>
      Promise.resolve({
        channels: [
          Float32Array.from({ length: 2000 }, (_, i) => Math.sin(i / 7)),
        ],
        sampleRate: 22_050,
      }),
    fetchBytes: () => Promise.resolve(new Uint8Array(8)),
    play: (sample) => {
      played.push(sample);
    },
    stop: () => {
      stopped.count += 1;
    },
  });
  return { played, player, stopped };
}

let panel: Panel | null = null;
const mount = (
  r: ReturnType<typeof rig>,
  onUse: (s: FreesoundSound, mode: string) => void = () => undefined
): HTMLElement => {
  panel = createFreesoundPanel({
    chipLabel: () => "Amiga",
    onUse,
    player: r.player,
  });
  document.body.append(panel.el);
  return panel.el;
};

const rows = (el: HTMLElement) => [
  ...el.querySelectorAll<HTMLElement>(".fs-row"),
];
const listbox = (el: HTMLElement) =>
  el.querySelector<HTMLElement>(".fs-list") as HTMLElement;
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: k,
      ...init,
    })
  );
const loaded = (el: HTMLElement) => until(() => rows(el).length > 0, 4000);

beforeEach(() => {
  clearSearchCache();
  localStorage.clear();
  // happy-dom has no layout, so there is nothing to scroll
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  panel?.dispose();
  panel?.el.remove();
  panel = null;
  vi.unstubAllGlobals();
});

describe("the list", () => {
  it("shows CC0 sounds first, each with its license, and credits Freesound", async () => {
    const asked = serve({ FREESOUND_CLIENT_SECRET: FIXTURE_KEY });
    const el = mount(rig());
    expect(await loaded(el)).toBe(true);
    const first = new URL(asked[0] as string, ORIGIN).searchParams;
    // CC0 is what an absent license parameter means
    expect(first.get("license")).toBeNull();
    expect(first.get("sub")).toBe("percussion");
    expect(rows(el).length).toBeGreaterThan(5);
    for (const row of rows(el)) {
      expect(row.querySelector(".lic")?.textContent).toBe("CC0");
      expect(row.querySelector(".fs-name")?.textContent).not.toBe("");
      expect(row.querySelector("a.fs-author")?.getAttribute("href")).toMatch(
        /^https:\/\/freesound\.org\//
      );
    }
    expect(el.querySelector(".fs-status")?.textContent).toContain("CC0 only");
    expect(el.querySelector(".fs-credit")?.textContent).toContain(
      "Sounds from Freesound.org"
    );
  });

  it("never lists a NonCommercial or Sampling+ sound, even with CC BY switched on", async () => {
    serve({ FREESOUND_CLIENT_SECRET: FIXTURE_KEY });
    const el = mount(rig());
    await loaded(el);
    const by = el.querySelector<HTMLInputElement>("#fs-by") as HTMLInputElement;
    by.checked = true;
    by.dispatchEvent(new Event("change", { bubbles: true }));
    expect(await until(() => el.querySelector(".lic-by") !== null, 4000)).toBe(
      true
    );
    const badges = new Set(
      rows(el).map((r) => r.querySelector(".lic")?.textContent)
    );
    expect(badges).toEqual(new Set(["CC0", "CC BY"]));
    expect(el.textContent).not.toMatch(/NonCommercial|Sampling/);
    expect(el.querySelector(".fs-status")?.textContent).toContain(
      "CC0 and CC BY"
    );
    // the choice is remembered for the next visit
    expect(localStorage.getItem("bleepkit:freesound:filters") ?? "").toContain(
      '"by"'
    );
  });

  it("searches again with the type, tag and sort a person picks", async () => {
    const asked = serve({ FREESOUND_CLIENT_SECRET: FIXTURE_KEY });
    const el = mount(rig());
    await loaded(el);
    const chip = (label: string) =>
      [...el.querySelectorAll<HTMLButtonElement>(".fs-chips button")].find(
        (b) => b.textContent === label
      ) as HTMLButtonElement;
    chip("Synths").click();
    expect(
      await until(() => asked.some((u) => u.includes("sub=synth")), 3000)
    ).toBe(true);
    const sort = el.querySelector<HTMLSelectElement>(
      "#fs-sort"
    ) as HTMLSelectElement;
    sort.value = "shortest";
    sort.dispatchEvent(new Event("change", { bubbles: true }));
    expect(
      await until(() => asked.some((u) => u.includes("sort=shortest")), 3000)
    ).toBe(true);
    const url = new URL(asked.at(-1) as string, ORIGIN).searchParams;
    expect(url.get("sub")).toBe("synth");
    expect(url.get("license")).toBeNull();
  });
});

describe("hearing a sound", () => {
  it("plays the row that is clicked, then the next one on the arrow key", async () => {
    serve({ FREESOUND_CLIENT_SECRET: FIXTURE_KEY });
    const r = rig();
    const el = mount(r);
    await loaded(el);
    const all = rows(el);
    (all[1] as HTMLElement).click();
    expect(await until(() => r.played.length === 1, 2000)).toBe(true);
    expect(listbox(el).getAttribute("aria-activedescendant")).toBe(
      (all[1] as HTMLElement).id
    );
    key(listbox(el), "ArrowDown");
    expect(await until(() => r.played.length === 2, 2000)).toBe(true);
    expect(listbox(el).getAttribute("aria-activedescendant")).toBe(
      (all[2] as HTMLElement).id
    );
    expect(all[2]?.getAttribute("aria-selected")).toBe("true");
    expect(all[1]?.getAttribute("aria-selected")).toBe("false");
    key(listbox(el), "ArrowUp");
    expect(await until(() => r.played.length === 3, 2000)).toBe(true);
    expect(listbox(el).getAttribute("aria-activedescendant")).toBe(
      (all[1] as HTMLElement).id
    );
    // Space plays the selected sound again
    key(listbox(el), " ");
    expect(await until(() => r.played.length === 4, 2000)).toBe(true);
  });

  it("starts at the first row when the down arrow is pressed in the search box", async () => {
    serve({ FREESOUND_CLIENT_SECRET: FIXTURE_KEY });
    const r = rig();
    const el = mount(r);
    await loaded(el);
    key(el.querySelector(".fs-q") as Element, "ArrowDown");
    expect(await until(() => r.played.length === 1, 2000)).toBe(true);
    expect(rows(el)[0]?.classList.contains("sel")).toBe(true);
  });

  it("loads the rows below the selection ahead, so the next arrow press is instant", async () => {
    serve({ FREESOUND_CLIENT_SECRET: FIXTURE_KEY });
    const r = rig();
    const fetches: number[] = [];
    const fetchBytes = vi.fn((sound: FreesoundSound) => {
      fetches.push(sound.id);
      return Promise.resolve(new Uint8Array(8));
    });
    const player = new PreviewPlayer({
      decode: () =>
        Promise.resolve({
          channels: [new Float32Array(500).fill(0.2)],
          sampleRate: 22_050,
        }),
      fetchBytes,
      play: (s) => {
        r.played.push(s);
      },
      stop: () => undefined,
    });
    const el = mount({ ...r, player });
    await loaded(el);
    (rows(el)[0] as HTMLElement).click();
    expect(await until(() => r.played.length === 1, 2000)).toBe(true);
    expect(await until(() => fetches.length >= 4, 2000)).toBe(true);
    const ids = rows(el).map((row) => Number(row.dataset.id));
    expect(new Set(fetches)).toEqual(new Set(ids.slice(0, 4)));
    // the second row is already decoded: playing it asks for no more bytes
    const before = fetchBytes.mock.calls.length;
    key(listbox(el), "ArrowDown");
    await settle(30);
    expect(r.played.length).toBe(2);
    expect(fetchBytes.mock.calls.length).toBeGreaterThanOrEqual(before);
    expect(fetches.filter((id) => id === ids[1])).toHaveLength(1);
  });

  it("hears only the newest row when the arrow key is held down", async () => {
    serve({ FREESOUND_CLIENT_SECRET: FIXTURE_KEY });
    const r = rig();
    const gate: (() => void)[] = [];
    const player = new PreviewPlayer({
      decode: () =>
        Promise.resolve({
          channels: [new Float32Array(500).fill(0.2)],
          sampleRate: 22_050,
        }),
      fetchBytes: () =>
        new Promise<Uint8Array>((resolve) => {
          gate.push(() => resolve(new Uint8Array(8)));
        }),
      play: (s) => {
        r.played.push(s);
      },
      stop: () => undefined,
    });
    const el = mount({ ...r, player });
    await loaded(el);
    const names = rows(el).map(
      (row) => row.querySelector(".fs-name")?.textContent
    );
    key(listbox(el), "ArrowDown");
    key(listbox(el), "ArrowDown");
    key(listbox(el), "ArrowDown");
    await settle(10);
    for (const open of gate) {
      open();
    }
    await settle(40);
    expect(r.played.map((s) => s.name)).toEqual([
      (names[2] ?? "").slice(0, 64),
    ]);
  });

  it("uses the selected sound with Enter, and makes an instrument with Shift+Enter", async () => {
    serve({ FREESOUND_CLIENT_SECRET: FIXTURE_KEY });
    const used: [number, string][] = [];
    const el = mount(rig(), (s, mode) => {
      used.push([s.id, mode]);
    });
    await loaded(el);
    key(listbox(el), "ArrowDown");
    key(listbox(el), "Enter");
    key(listbox(el), "Enter", { shiftKey: true });
    const id = Number(rows(el)[0]?.dataset.id);
    expect(used).toEqual([
      [id, "sample"],
      [id, "instrument"],
    ]);
  });
});

describe("without the Freesound service", () => {
  it("says the key is missing, and offers to try again", async () => {
    const asked = serve({});
    const el = mount(rig());
    expect(
      await until(() => el.querySelector(".fs-unavailable") !== null, 3000)
    ).toBe(true);
    expect(el.querySelector(".fs-unavailable")?.textContent).toContain(
      "FREESOUND_CLIENT_SECRET"
    );
    expect(el.querySelector(".fs-unavailable h3")?.textContent).toBe(
      "Freesound is not set up here"
    );
    expect(rows(el)).toHaveLength(0);
    const before = asked.length;
    (el.querySelector(".fs-unavailable button") as HTMLButtonElement).click();
    expect(await until(() => asked.length > before, 2000)).toBe(true);
  });

  it("says there is no studio server when the routes are not there at all", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response("<html>Not found</html>", { status: 404 }))
    );
    const el = mount(rig());
    expect(
      await until(() => el.querySelector(".fs-unavailable") !== null, 3000)
    ).toBe(true);
    expect(el.querySelector(".fs-unavailable h3")?.textContent).toBe(
      "Freesound is not available here"
    );
  });

  it("recovers when the key appears and the person tries again", async () => {
    serve({});
    const el = mount(rig());
    await until(() => el.querySelector(".fs-unavailable") !== null, 3000);
    serve({ FREESOUND_CLIENT_SECRET: FIXTURE_KEY });
    (el.querySelector(".fs-unavailable button") as HTMLButtonElement).click();
    expect(await loaded(el)).toBe(true);
    expect(el.querySelector(".fs-unavailable")).toBeNull();
  });
});
