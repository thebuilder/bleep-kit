/* The views mounted in the real shell, on the fake engine and a browser store, driven the way a person drives them:
   pressing pads, dragging sliders, typing into the tracker, clicking buttons. The shell is real, so what each test
   checks is what the person gets: the sound the engine is handed, the document the project holds, the file the store
   keeps, the page the app navigates to. The engine node's `send` is wrapped to record every message it receives. */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import indexHtml from "../index.html?raw";
import type { Instrument, Sfx, Song } from "../src/lib/contract.ts";
import {
  chipProfile,
  defaultSong,
  renderSfx as renderSound,
} from "../src/lib/core.ts";
import {
  field,
  filledRects,
  installCanvasStub,
  setRange,
  settle,
  until,
} from "./helpers.ts";

installCanvasStub();
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

type AppMod = typeof import("../src/app.ts");
type DocsMod = typeof import("../src/state/docs.ts");
type EngineMod = typeof import("../src/engine/engine.ts");
type LoopMod = typeof import("../src/visuals/loop.ts");

let appMod: AppMod;
let docsMod: DocsMod;
let engineMod: EngineMod;
let loopMod: LoopMod;

/** Every message the studio has sent its engine node since boot, oldest first. */
const sent: { type: string; [k: string]: unknown }[] = [];
const sentSince = (mark: number, type?: string) =>
  sent.slice(mark).filter((m) => !type || m.type === type);
const triggers = (mark: number) =>
  sentSince(mark, "trigger").map((m) => m.id as string);
/** The last version of sound `id` the engine was handed after `mark`. */
const uploaded = (mark: number, id: string) =>
  sentSince(mark, "loadSfx")
    .filter((m) => m.id === id)
    .at(-1)?.sfx as Sfx | undefined;

const view = () => document.getElementById("view") as HTMLElement;
const insp = () => document.getElementById("insp") as HTMLElement;
const project = () => docsMod.project;
const sfxValue = (id: string) => project().get("sfx", id)?.value as Sfx;
const songValue = (id: string) => project().get("song", id)?.value as Song;
const instValue = (id: string) =>
  project().get("instrument", id)?.value as Instrument;
const clone = <T>(v: T): T => structuredClone(v);

/** The text of the toast, or "" when it is hidden. */
const toast = () => {
  const el = document.getElementById("toast") as HTMLElement;
  return el.hidden ? "" : (el.querySelector("span")?.textContent ?? "");
};

const fire = (el: Element, type: string, init: EventInit = {}) =>
  el.dispatchEvent(new Event(type, { bubbles: true, ...init }));

const key = (
  k: string,
  init: KeyboardEventInit = {},
  el: Element = document.body
) =>
  el.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: k,
      ...init,
    })
  );

const press = (el: Element | null) => {
  expect(el).not.toBeNull();
  (el as HTMLElement).click();
};
/** happy-dom hands a click inside a <label> on to the label's first control, which a browser does not do for a button
    inside it; the octave buttons sit in a label, so stop that here. */
const pressInLabel = (el: Element | null) => {
  el?.addEventListener("click", (e) => e.preventDefault(), { once: true });
  press(el);
};
const pointerDown = (el: Element, init: PointerEventInit = {}) =>
  el.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, button: 0, ...init })
  );

const go = async (hash: string, ready: () => boolean) => {
  appMod.app.navigate(hash);
  expect(await until(ready, 6000)).toBe(true);
  // a hashchange queued by an earlier navigation lands after this one; let it, so it cannot remount the view mid-test
  await settle(30);
};
const goSfx = (id: string) =>
  go(`#/sfx/${id}`, () => document.querySelector("#sName") !== null);
const goSong = (id: string) =>
  go(`#/song/${id}`, () => document.querySelectorAll(".trow").length > 8);
const goInstrument = (id: string) =>
  go(`#/instrument/${id}`, () => document.getElementById("iKeys") !== null);
const goProject = () =>
  go("#/project", () => document.getElementById("pGo") !== null);

/** The stored JSON of a document, read straight from the store the project writes to. */
const stored = async <T>(path: string) =>
  (await project().store.readJson(path)).json as T;

/** Any of the three kinds of control a field holds, with what each of them has. */
interface Control extends HTMLElement {
  checked: boolean;
  disabled: boolean;
  max: string;
  min: string;
  options: HTMLOptionsCollection;
  type: string;
  value: string;
}

/**
 * Move every slider, select and switch of `root` and report the labels of the ones that did not change what
 * `snapshot` reads: a control that looks alive and does nothing. `tested` guards against passing on an empty form.
 * Controls that are greyed out or in a hidden group are not expected to work.
 */
function unwired(
  root: () => Element,
  snapshot: () => string,
  skip: (label: string) => boolean = () => false
): { dead: string[]; tested: number } {
  const dead: string[] = [];
  let tested = 0;
  const rows = () => [...root().querySelectorAll(".fld")];
  const pick = (row: Element | undefined) =>
    (row?.querySelector("input[type=range], select, input[type=checkbox]") ??
      null) as Control | null;
  const count = rows().length;
  for (let i = 0; i < count; i += 1) {
    const row = rows()[i];
    const label = row?.querySelector("label")?.textContent ?? "";
    const first = pick(row);
    if (!first || first.disabled || row?.closest("[hidden]") || skip(label)) {
      continue;
    }
    tested += 1;
    const before = snapshot();
    const attempts: (() => void)[] = [];
    if (first.type === "range") {
      for (const v of [first.max, first.min]) {
        attempts.push(() => {
          const live = pick(rows()[i]) ?? first;
          live.value = v;
          fire(live, "input");
        });
      }
    } else if (first.type === "checkbox") {
      attempts.push(() => (pick(rows()[i]) ?? first).click());
    } else {
      for (const o of Array.from(first.options)) {
        if (!o.disabled && o.value !== first.value) {
          attempts.push(() => {
            const live = pick(rows()[i]) ?? first;
            live.value = o.value;
            fire(live, "change");
          });
        }
      }
    }
    let changed = false;
    for (const attempt of attempts) {
      attempt();
      if (snapshot() !== before) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      dead.push(`${i}:${label}`);
    }
  }
  return { dead, tested };
}

beforeAll(async () => {
  vi.stubGlobal("confirm", () => true);
  // happy-dom lays nothing out: give the piano and the macro bars the size they have in the studio (14 white keys of
  // 24 px, bars of 300 by 80) so pointer positions mean something
  const layout = HTMLCanvasElement.prototype.getBoundingClientRect;
  HTMLCanvasElement.prototype.getBoundingClientRect = function sized() {
    const [w, h] = (() => {
      if (this.id === "iKeys") {
        return [336, 60];
      }
      return this.closest(".macro") ? [300, 80] : [0, 0];
    })();
    if (w === 0) {
      return layout.call(this);
    }
    return {
      bottom: h,
      height: h,
      left: 0,
      right: w,
      top: 0,
      width: w,
      x: 0,
      y: 0,
    } as DOMRect;
  };
  (
    window as unknown as { happyDOM?: { setURL: (url: string) => void } }
  ).happyDOM?.setURL("http://localhost:3000/?engine=fake&store=local#/pads");
  document.body.innerHTML =
    '<canvas id="backdrop"></canvas><div id="app"></div>';
  appMod = await import("../src/app.ts");
  docsMod = await import("../src/state/docs.ts");
  engineMod = await import("../src/engine/engine.ts");
  loopMod = await import("../src/visuals/loop.ts");
  const { boot } = await import("../src/shell.ts");
  await boot(document.getElementById("app") as HTMLElement);
  const { node } = engineMod.engine;
  if (node) {
    const send = node.send.bind(node);
    node.send = (msg) => {
      sent.push(msg as never);
      send(msg);
    };
  }
  await until(() => document.querySelectorAll(".pad[data-id]").length > 0);
});

const pads = () => [...document.querySelectorAll<HTMLElement>(".pad[data-id]")];
const padId = (el: HTMLElement | undefined) => el?.dataset.id as string;

describe("pads", () => {
  it("shows one pad per sound, labelled with the key that plays it", () => {
    expect(pads().map(padId).sort()).toEqual(
      project()
        .list("sfx")
        .map((d) => d.id)
        .sort()
    );
    expect(
      pads()
        .slice(0, 12)
        .map((p) => p.querySelector(".key")?.textContent)
    ).toEqual([..."1234567890QW"]);
  });

  it("a pointer press, Enter and a number key each hand the engine the sound of the pad and trigger it", () => {
    const [a, b, c] = pads() as [HTMLElement, HTMLElement, HTMLElement];
    const mark = sent.length;
    pointerDown(a);
    b.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
    );
    key("3");
    expect(triggers(mark)).toEqual([padId(a), padId(b), padId(c)]);
    for (const pad of [a, b, c]) {
      expect(uploaded(mark, padId(pad))).toEqual(sfxValue(padId(pad)));
    }
    expect(a.classList.contains("hit")).toBe(true);
    expect(c.classList.contains("sel")).toBe(true);
    expect(insp().textContent).toContain(sfxValue(padId(c)).name);
  });

  it("ignores keys that are not pad keys", () => {
    const mark = sent.length;
    key("-");
    key("é");
    expect(triggers(mark)).toEqual([]);
  });

  it("offers four audibly different variations of a pad and plays each as a separate sound", () => {
    const pad = pads()[0] as HTMLElement;
    const id = padId(pad);
    const source = sfxValue(id);
    press(pad.querySelector('[data-act="mutate"]'));
    const tiles = [...document.querySelectorAll<HTMLElement>(".vtile")];
    expect(tiles).toHaveLength(4);
    const mark = sent.length;
    for (const tile of tiles) {
      pointerDown(tile);
    }
    expect(triggers(mark)).toEqual(
      [0, 1, 2, 3].map((i) => `variant:${id}:${i}`)
    );
    const heard = [0, 1, 2, 3].map((i) => uploaded(mark, `variant:${id}:${i}`));
    expect(new Set(heard.map((s) => JSON.stringify(s))).size).toBe(4);
    for (const s of heard) {
      expect(s).not.toEqual(source);
      expect(s?.category).toBe(source.category);
    }
    press(document.querySelector('.drawer [data-act="close"]'));
    expect(document.querySelector(".drawer")).toBeNull();
  });

  it("More brings a new set of variations, and the mutate button closes the drawer it opened", () => {
    const pad = pads()[0] as HTMLElement;
    const id = padId(pad);
    const mutate = pad.querySelector('[data-act="mutate"]');
    press(mutate);
    const mark = sent.length;
    pointerDown(document.querySelector(".vtile") as HTMLElement);
    const first = uploaded(mark, `variant:${id}:0`);
    press(document.querySelector('.drawer [data-act="reroll"]'));
    expect(document.querySelectorAll(".vtile")).toHaveLength(4);
    pointerDown(document.querySelector(".vtile") as HTMLElement);
    expect(uploaded(mark, `variant:${id}:0`)).not.toEqual(first);
    press(mutate);
    expect(document.querySelector(".drawer")).toBeNull();
  });

  it("keeping a variation saves exactly the sound that was auditioned as a new sound", async () => {
    const pad = pads()[0] as HTMLElement;
    const id = padId(pad);
    const base = sfxValue(id);
    const before = new Set(
      project()
        .list("sfx")
        .map((d) => d.id)
    );
    press(pad.querySelector('[data-act="mutate"]'));
    const tile = document.querySelectorAll<HTMLElement>(
      ".vtile"
    )[2] as HTMLElement;
    pointerDown(tile);
    // the engine keeps a sound it already has, so what it was handed may date from an earlier audition
    const heard = uploaded(0, `variant:${id}:2`) as Sfx;
    expect(heard).toBeDefined();
    press(tile.querySelector('[data-act="keep"]'));
    expect(
      await until(() => project().list("sfx").length === before.size + 1)
    ).toBe(true);
    const made = project()
      .list("sfx")
      .find((d) => !before.has(d.id));
    expect(made?.value).toEqual({ ...heard, name: `${base.name} mod` });
    expect(await stored(made?.path as string)).toEqual(made?.value);
    expect(toast()).toBe(`Kept as ${made?.id}`);
  });

  it("randomizing plays the new sound, keeps the pad's name, category and chip, and the toast undoes it", async () => {
    const pad = pads()[1] as HTMLElement;
    const id = padId(pad);
    const before = clone(sfxValue(id));
    const mark = sent.length;
    press(pad.querySelector('[data-act="randomize"]'));
    const after = sfxValue(id);
    expect(after).not.toEqual(before);
    expect([after.name, after.category, after.chip]).toEqual([
      before.name,
      before.category,
      before.chip,
    ]);
    expect(triggers(mark)).toEqual([id]);
    expect(uploaded(mark, id)).toEqual(after);
    expect(toast()).toBe(`Randomized ${before.name}`);
    press(document.querySelector("#toast button"));
    expect(sfxValue(id)).toEqual(before);
    expect(triggers(mark)).toEqual([id, id]);
    expect(uploaded(mark, id)).toEqual(before);
    await settle(30);
  });

  it("renaming a pad in the inspector shows on the pad and reaches the store by itself", async () => {
    const pad = pads()[2] as HTMLElement;
    const id = padId(pad);
    pointerDown(pad);
    const name = field(insp(), "Name");
    name.value = "Renamed pad";
    fire(name, "input");
    setRange(field(insp(), "Volume"), 0.4);
    expect(pad.querySelector(".nm")?.textContent).toBe("Renamed pad");
    expect(sfxValue(id)).toMatchObject({ name: "Renamed pad", volume: 0.4 });
    const doc = project().get("sfx", id);
    expect(doc?.dirty).toBe(true);
    // autosave writes it 800 ms after the last change
    expect(await until(() => doc?.dirty === false, 4000)).toBe(true);
    expect(await stored(doc?.path as string)).toMatchObject({
      name: "Renamed pad",
      volume: 0.4,
    });
  });

  it("a new sound from the category picker has that category, plays at once and is saved", async () => {
    const before = new Set(
      project()
        .list("sfx")
        .map((d) => d.id)
    );
    const mark = sent.length;
    press(document.querySelector(".pad-new"));
    const tile = [...document.querySelectorAll<HTMLElement>(".cat-tile")].find(
      (t) => t.querySelector("b")?.textContent === "Explosion"
    );
    press(tile ?? null);
    expect(await until(() => project().list("sfx").length > before.size)).toBe(
      true
    );
    const made = project()
      .list("sfx")
      .find((d) => !before.has(d.id)) as ReturnType<
      DocsMod["project"]["list"]
    >[number];
    expect(made.value).toMatchObject({
      category: "explosion",
      chip: project().project.chip,
    });
    expect(triggers(mark)).toEqual([made.id]);
    expect(await stored(made.path)).toEqual(made.value);
    expect(await until(() => pads().some((p) => padId(p) === made.id))).toBe(
      true
    );
  });

  it("duplicating a pad saves a copy under a new id, and deleting removes it from the project and the store", async () => {
    const pad = pads()[3] as HTMLElement;
    const id = padId(pad);
    pointerDown(pad);
    const original = sfxValue(id);
    const before = new Set(
      project()
        .list("sfx")
        .map((d) => d.id)
    );
    press(
      [...insp().querySelectorAll<HTMLElement>(".btn")].find(
        (b) => b.textContent === "Duplicate"
      ) ?? null
    );
    expect(await until(() => project().list("sfx").length > before.size)).toBe(
      true
    );
    const copy = project()
      .list("sfx")
      .find((d) => !before.has(d.id)) as ReturnType<
      DocsMod["project"]["list"]
    >[number];
    expect(copy.id).not.toBe(id);
    expect(copy.value).toEqual({ ...original, name: `${original.name} copy` });
    expect(await stored(copy.path)).toEqual(copy.value);

    await until(() => pads().some((p) => padId(p) === copy.id));
    pointerDown(pads().find((p) => padId(p) === copy.id) as HTMLElement);
    press(
      [...insp().querySelectorAll<HTMLElement>(".btn")].find(
        (b) => b.textContent === "Delete"
      ) ?? null
    );
    expect(await until(() => project().get("sfx", copy.id) === undefined)).toBe(
      true
    );
    await expect(project().store.readJson(copy.path)).rejects.toThrow();
    expect(await until(() => !pads().some((p) => padId(p) === copy.id))).toBe(
      true
    );
    expect(project().get("sfx", id)?.value).toEqual(original);
  });
});

/** Put a sound back as it was after a test has moved its controls. */
const restoreSfx = (id: string, original: Sfx) =>
  project().edit<Sfx>(project().get("sfx", id) as never, () => clone(original));

describe("the sfx editor", () => {
  it("every control of a sound with a plain wave edits the document", async () => {
    await goSfx("coin");
    const original = clone(sfxValue("coin"));
    const { dead, tested } = unwired(insp, () =>
      JSON.stringify(sfxValue("coin"))
    );
    restoreSfx("coin", original);
    expect(tested).toBeGreaterThan(15);
    expect(dead).toEqual([]);
  });

  it("the FM patch appears with the fm wave, and its controls edit the document", async () => {
    await goSfx("coin");
    const original = clone(sfxValue("coin"));
    const set = (id: string, value: string) => {
      const el = document.getElementById(id) as HTMLSelectElement;
      el.value = value;
      fire(el, "change");
    };
    // the NES has no FM channel, so the wave is not on offer there
    set("sChip", "genesis");
    const wave = field<HTMLSelectElement>(insp(), "Wave");
    wave.value = "fm";
    fire(wave, "change");
    expect(sfxValue("coin").wave).toBe("fm");
    const { dead, tested } = unwired(
      insp,
      () => JSON.stringify(sfxValue("coin").fm ?? null),
      (label) => !["Ratio", "Index", "Index decay"].includes(label)
    );
    restoreSfx("coin", original);
    expect(tested).toBe(3);
    expect(dead).toEqual([]);
  });

  it("every sound of every category opens with working controls", async () => {
    const failures: string[] = [];
    for (const d of project().list("sfx")) {
      // biome-ignore lint/performance/noAwaitInLoops: one editor at a time, each is mounted and unmounted in order
      await goSfx(d.id);
      expect((document.getElementById("sName") as HTMLInputElement).value).toBe(
        (d.value as Sfx).name
      );
      const original = clone(sfxValue(d.id));
      const { dead } = unwired(insp, () => JSON.stringify(sfxValue(d.id)));
      restoreSfx(d.id, original);
      if (dead.length) {
        failures.push(`${d.id}: ${dead.join(", ")}`);
      }
    }
    expect(failures).toEqual([]);
  });

  const lock = (group: string, on = true) => {
    const btn = insp().querySelector<HTMLElement>(
      `.lk[aria-label="Lock ${group}"]`
    );
    if (btn?.getAttribute("aria-pressed") !== String(on)) {
      press(btn);
    }
  };

  it("randomize and mutate change the sound, keep a locked group, and keep the name, chip, category and volume", async () => {
    await goSfx("coin");
    const original = clone(sfxValue("coin"));
    for (const button of ["sRand", "sMut"]) {
      lock("Envelope");
      lock("Wave");
      const mark = sent.length;
      press(document.getElementById(button));
      const now = sfxValue("coin");
      expect(now.envelope).toEqual(original.envelope);
      expect(now.wave).toBe(original.wave);
      expect([now.name, now.chip, now.category, now.volume]).toEqual([
        original.name,
        original.chip,
        original.category,
        original.volume,
      ]);
      expect(now).not.toEqual(original);
      // and the edit is heard
      expect(triggers(mark)).toContain("coin");
      expect(uploaded(mark, "coin")).toEqual(now);
      restoreSfx("coin", original);
    }
    // an unlocked group does move
    lock("Envelope", false);
    press(document.getElementById("sRand"));
    expect(sfxValue("coin").envelope).not.toEqual(original.envelope);
    restoreSfx("coin", original);
  });

  /* The inspector is rebuilt after every randomize and mutate, so the lock is kept by the view and has to survive it:
     pressing Randomize again with the envelope locked must not throw the envelope away. */
  it("a lock keeps holding for the next randomize", async () => {
    await goSfx("coin");
    const original = clone(sfxValue("coin"));
    lock("Envelope");
    press(document.getElementById("sRand"));
    press(document.getElementById("sRand"));
    try {
      expect(sfxValue("coin").envelope).toEqual(original.envelope);
    } finally {
      restoreSfx("coin", original);
    }
  });

  it("plays on request, and the keys r and m randomize and mutate", async () => {
    await goSfx("coin");
    const original = clone(sfxValue("coin"));
    const mark = sent.length;
    press(document.getElementById("sPlay"));
    expect(triggers(mark)).toEqual(["coin"]);
    key("r");
    const randomized = clone(sfxValue("coin"));
    expect(randomized).not.toEqual(original);
    key("m");
    expect(sfxValue("coin")).not.toEqual(randomized);
    project().undo(project().get("sfx", "coin") as never);
    project().undo(project().get("sfx", "coin") as never);
    expect(sfxValue("coin")).toEqual(original);
  });

  it("the spectrogram button shows and hides the spectrogram, and Analyse opens this sound's analysis", async () => {
    await goSfx("coin");
    const box = () =>
      document.getElementById("sSpecBtn")?.getAttribute("aria-pressed");
    const before = box();
    press(document.getElementById("sSpecBtn"));
    expect(box()).toBe(before === "true" ? "false" : "true");
    press(document.getElementById("sSpecBtn"));
    expect(box()).toBe(before);
    press(document.getElementById("sAna"));
    expect(location.hash).toBe("#/analysis/sfx/coin");
    expect(
      await until(() => document.getElementById("aRerun") !== null, 6000)
    ).toBe(true);
  });
});

describe("switches and the save icon", () => {
  const css = indexHtml;
  const rule = (selector: string) =>
    new RegExp(`${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(
      css
    )?.[1] ?? "";

  /** How much a render changed, as the size of the difference relative to the size of the first render. */
  const changeOf = (a: Sfx, b: Sfx) => {
    const x = renderSound(a, { sampleRate: 22_050 })
      .channels[0] as Float32Array;
    const y = renderSound(b, { sampleRate: 22_050 })
      .channels[0] as Float32Array;
    let diff = 0;
    let level = 0;
    for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
      diff += ((x[i] ?? 0) - (y[i] ?? 0)) ** 2;
      level += (x[i] ?? 0) ** 2;
    }
    return Math.sqrt(diff / Math.max(level, 1e-12));
  };
  const pick = (id: string, value: string) => {
    const el = document.getElementById(id) as HTMLSelectElement;
    el.value = value;
    fire(el, "change");
  };

  it("the drawn switch never covers the input, so a click on the switch itself toggles it", () => {
    // a browser sends the click to whatever is on top; the drawn span used to sit above the invisible input
    expect(rule(".tgl input")).toMatch(/z-index:\s*[1-9]/);
    expect(rule(".tgl input")).toMatch(/opacity:\s*0/);
  });

  it("the Lowpass, Highpass and Bit crush switches write the sound, hand it to the engine and change what is heard", async () => {
    await goSfx("coin");
    const original = clone(sfxValue("coin"));
    const switches: [string, (s: Sfx) => number | null][] = [
      ["Lowpass", (s) => s.filter.lowpass],
      ["Highpass", (s) => s.filter.highpass],
      ["Bit crush", (s) => s.bitcrush.bits],
    ];
    const failures: string[] = [];
    for (const chip of ["c64", "custom"]) {
      pick("sChip", chip);
      pick("sChip", chip);
      const wave = field<HTMLSelectElement>(insp(), "Wave");
      wave.value = "saw";
      fire(wave, "change");
      for (const [label, read] of switches) {
        const before = clone(sfxValue("coin"));
        const mark = sent.length;
        const input = field(insp(), label);
        input.click();
        const after = clone(sfxValue("coin"));
        if (read(before) !== null || read(after) === null) {
          failures.push(`${chip} ${label}: document`);
        }
        // biome-ignore lint/performance/noAwaitInLoops: one switch at a time, each waits for the engine
        const handed = await until(() => {
          const sound = uploaded(mark, "coin");
          return sound !== undefined && read(sound) !== null;
        }, 2000);
        if (!handed) {
          failures.push(`${chip} ${label}: engine`);
        }
        if (changeOf(before, after) < 0.03) {
          failures.push(`${chip} ${label}: sound`);
        }
        // the value control next to the switch shows the value the switch turned on
        const row = input.closest(".fld")?.nextElementSibling;
        const shown =
          row?.querySelector<HTMLInputElement>("input[type=number]");
        if (Number(shown?.value) !== read(after)) {
          failures.push(`${chip} ${label}: value box`);
        }
        input.click();
        if (read(sfxValue("coin")) !== null) {
          failures.push(`${chip} ${label}: off again`);
        }
      }
    }
    restoreSfx("coin", original);
    expect(failures).toEqual([]);
  });

  it("the filter hint names the chips that have a filter, and the Filter group works only on them", async () => {
    await goSfx("coin");
    const original = clone(sfxValue("coin"));
    const hint = () =>
      (document.getElementById("sHint") as HTMLElement).textContent;
    for (const chip of [
      "adlib",
      "c64",
      "custom",
      "gameboy",
      "genesis",
      "nes",
      "snes",
    ] as const) {
      pick("sChip", chip);
      const has = chipProfile(chip).constraints.filter;
      expect(field(insp(), "Lowpass").disabled, chip).toBe(!has);
      expect(field(insp(), "Highpass").disabled, chip).toBe(!has);
      if (has) {
        expect(hint(), chip).not.toContain("no filter");
      } else {
        expect(hint(), chip).toMatch(
          / has no filter\. Switch the chip to C64 or Custom to use one\./
        );
      }
    }
    expect(
      ["c64", "custom"].every((c) => chipProfile(c as "c64").constraints.filter)
    ).toBe(true);
    restoreSfx("coin", original);
  });

  it("the sound editor ends in the two buttons, without the long description", async () => {
    await goSfx("coin");
    expect(view().querySelector("#sDesc")).toBeNull();
    expect(view().querySelector(".ed-foot")?.textContent).not.toContain(
      "coin sound"
    );
    expect(view().querySelectorAll(".ed-foot button").length).toBe(2);
  });

  it("the save icon is one fixed size icon that changes its state and words, never its shape", async () => {
    await goSfx("coin");
    await project().saveAll();
    const icon = document.getElementById("saveState") as HTMLElement;
    const doc = project().get("sfx", "coin") as never;
    const shape = icon.innerHTML;
    const state = () => [
      icon.dataset.state,
      icon.getAttribute("aria-label"),
      icon.title,
    ];
    expect(icon.textContent).toBe("");
    expect(icon.querySelectorAll("svg").length).toBe(1);
    expect(state()).toEqual(["saved", "Saved", "Saved"]);
    // the icon has a fixed box whatever the state, and only the colour follows the state
    expect(rule(".savestate")).toMatch(/width:\s*24px/);
    expect(rule(".savestate")).toMatch(/height:\s*24px/);
    for (const s of ["unsaved", "saving", "error"]) {
      expect(css).toContain(`.savestate[data-state="${s}"]`);
    }

    project().edit<Sfx>(doc, (d) => {
      d.volume = d.volume === 0.5 ? 0.4 : 0.5;
    });
    expect(state()).toEqual([
      "unsaved",
      "Unsaved changes, autosave pending",
      "Unsaved changes, autosave pending",
    ]);
    const saving = project().save(doc);
    expect(state()[0]).toBe("saving");
    expect(state()[1]).toBe("Saving");
    await saving;
    expect(state()).toEqual(["saved", "Saved", "Saved"]);

    project().edit<Sfx>(doc, (d) => {
      d.volume = d.volume === 0.5 ? 0.4 : 0.5;
    });
    vi.spyOn(project().store, "writeJson").mockResolvedValueOnce({
      message: "disk full",
      ok: false,
      reason: "error",
    });
    await project().save(doc);
    expect(state()[0]).toBe("error");
    expect(state()[1]).toBe("Could not save, see the log");
    await project().save(doc);
    expect(state()[0]).toBe("saved");
    expect(icon.innerHTML).toBe(shape);
    expect(icon.textContent).toBe("");
  });
});

describe("the song editor", () => {
  const SONG = "tracker-test";
  const ch = 0;
  const rowsOf = (channel = ch) => {
    const s = songValue(SONG);
    const id = s.channels[channel]?.id as string;
    return s.patterns[s.order[0] as string]?.tracks[id] ?? [];
  };
  const tracker = () => document.getElementById("gTracker") as HTMLElement;
  const typeKeys = (...keys: string[]) => {
    for (const k of keys) {
      key(k, {}, tracker());
    }
  };
  /** The row the tracker cursor is on, and the field of it. */
  const cursor = () => {
    const span = document.querySelector<HTMLElement>(".tr-body .tc .cur");
    return {
      ch: Number(span?.closest<HTMLElement>(".tc")?.dataset.ch),
      field: Number(span?.dataset.f),
      row: Number(span?.closest<HTMLElement>(".trow")?.dataset.r),
    };
  };
  /** Click a field of a cell, as the mouse does, to put the cursor there. */
  const clickCell = (row: number, channel: number, f: number) =>
    pointerDown(
      document.querySelector(
        `.trow[data-r="${row}"] .tc[data-ch="${channel}"] [data-f="${f}"]`
      ) as Element
    );
  const octave = () => Number(document.getElementById("gOct")?.textContent);
  const lowestNote = () => (octave() + 1) * 12;

  /** A blank song of the project's chip with `orders` empty patterns, looping back to `loop`. */
  const makeSong = async (
    id: string,
    over: Partial<Song> = {},
    orders = 1
  ): Promise<void> => {
    const song = defaultSong(project().project.chip);
    song.name = id;
    song.patterns = Object.fromEntries(
      Array.from({ length: orders }, (_, i) => [
        `pattern-${i + 1}`,
        { length: 64, tracks: {} },
      ])
    );
    song.order = Object.keys(song.patterns);
    await project().create("song", id, { ...song, ...over });
  };

  beforeAll(async () => {
    await makeSong(SONG);
  });
  // the songs these tests made are blank; take them away so later tests see the starter project
  afterAll(async () => {
    await go("#/pads", () => document.querySelector(".pad[data-id]") !== null);
    await Promise.all(
      project()
        .list("song")
        .filter((d) => d.id !== "starter-theme")
        .map((d) => project().remove(d))
    );
  });

  it("typing piano keys writes notes down the note column, one row each", async () => {
    await goSong(SONG);
    expect(cursor()).toEqual({ ch: 0, field: 0, row: 0 });
    const mark = sent.length;
    typeKeys("z", "s", "x");
    const base = lowestNote();
    expect(rowsOf()).toMatchObject([
      { note: base, row: 0 },
      { note: base + 1, row: 1 },
      { note: base + 2, row: 2 },
    ]);
    expect(cursor().row).toBe(3);
    // each key is heard as it is typed
    expect(
      sentSince(mark, "noteOn")
        .map((m) => m.note)
        .slice(0, 3)
    ).toEqual([base, base + 1, base + 2]);
    // the grid shows what the document holds
    expect(
      document.querySelector('.trow[data-r="1"] .tc[data-ch="0"] [data-f="0"]')
        ?.textContent
    ).toMatch(/^C#/);
  });

  it("1 is note off, the backtick is release, Delete clears and moves down, Backspace clears and stays", () => {
    typeKeys("1", "`");
    expect(rowsOf().map((r) => [r.row, r.note])).toEqual([
      [0, lowestNote()],
      [1, lowestNote() + 1],
      [2, lowestNote() + 2],
      [3, "off"],
      [4, "release"],
    ]);
    typeKeys("ArrowUp", "ArrowUp", "ArrowUp");
    expect(cursor().row).toBe(2);
    typeKeys("Delete");
    expect(rowsOf().map((r) => r.row)).toEqual([0, 1, 3, 4]);
    expect(cursor().row).toBe(3);
    typeKeys("Backspace");
    expect(rowsOf().map((r) => r.row)).toEqual([0, 1, 4]);
    expect(cursor().row).toBe(3);
  });

  it("the octave buttons shift the notes the keys write", () => {
    const o = octave();
    pressInLabel(document.getElementById("gOctUp"));
    expect(octave()).toBe(o + 1);
    typeKeys("z");
    expect(rowsOf().find((r) => r.row === 3)?.note).toBe((o + 2) * 12);
    pressInLabel(document.getElementById("gOctDn"));
    expect(octave()).toBe(o);
    // the keys - and = do the same
    typeKeys("=", "=");
    expect(octave()).toBe(o + 2);
    typeKeys("-", "-");
    expect(octave()).toBe(o);
  });

  it("the cursor keys move around the grid and stop at its edges", () => {
    typeKeys("Home");
    expect(cursor()).toEqual({ ch: 0, field: 0, row: 0 });
    typeKeys("ArrowUp");
    expect(cursor().row).toBe(0);
    typeKeys("PageDown");
    expect(cursor().row).toBe(16);
    typeKeys("End");
    expect(cursor().row).toBe(63);
    typeKeys("ArrowDown");
    expect(cursor().row).toBe(63);
    typeKeys("Home", "ArrowRight");
    expect(cursor()).toMatchObject({ ch: 0, field: 1, row: 0 });
    typeKeys("Tab");
    expect(cursor().ch).toBe(1);
    key("Tab", { shiftKey: true }, tracker());
    expect(cursor().ch).toBe(0);
    typeKeys("ArrowLeft");
    expect(cursor().field).toBe(0);
    typeKeys("ArrowLeft");
    expect(cursor().ch).toBe(songValue(SONG).channels.length - 1);
    typeKeys("Tab");
    expect(cursor().ch).toBe(0);
  });

  it("the instrument column takes two hex digits, volume one, and refuses an instrument that does not exist", () => {
    const instruments = Object.keys(project().instruments()).sort();
    clickCell(0, 0, 1);
    expect(cursor()).toEqual({ ch: 0, field: 1, row: 0 });
    typeKeys("0", "1");
    expect(rowsOf().find((r) => r.row === 0)?.inst).toBe(instruments[1]);
    expect(cursor().row).toBe(1);
    const before = clone(rowsOf());
    typeKeys("e", "e");
    expect(toast()).toMatch(/^There is no instrument EE/);
    expect(rowsOf()).toEqual(before);
    clickCell(0, 0, 2);
    typeKeys("a");
    expect(rowsOf().find((r) => r.row === 0)?.vol).toBe(10);
  });

  it("an effect column takes a letter or digit and two hex digits, and refuses a code that is not an effect", () => {
    clickCell(0, 0, 3);
    typeKeys("a", "0", "e");
    expect(rowsOf().find((r) => r.row === 0)?.fx).toEqual([
      { type: "volSlide", x: 0, y: 14 },
    ]);
    const before = clone(rowsOf());
    typeKeys("z", "z", "z");
    expect(toast()).toMatch(/^ZZZ is not an effect/);
    expect(rowsOf()).toEqual(before);
  });

  /* F is a hex digit and also the Follow key. Follow only takes it in the note column (where F is not a note key), so
     the volume, instrument and effect columns see F as a hex digit: the top volume and codes like A0F can be typed. */
  it("the volume column takes F, the top volume", () => {
    clickCell(0, 0, 2);
    typeKeys("f");
    expect(rowsOf().find((r) => r.row === 0)?.vol).toBe(15);
  });

  it("an effect code ending in F, the example the hint gives, can be typed", () => {
    clickCell(1, 0, 3);
    typeKeys("a", "0", "f");
    expect(rowsOf().find((r) => r.row === 1)?.fx).toEqual([
      { type: "volSlide", x: 0, y: 15 },
    ]);
  });

  /* The hint's example for an arpeggio has to be an arpeggio: in the effect table A is the volume slide and the
     arpeggio is 0xy. */
  it("the example effect code in the hint for a bad code is the effect it names", () => {
    typeKeys("z", "z", "z");
    const [, code, name] = /Try (\w{3}) \((\w+)\)/.exec(toast()) ?? [];
    expect(name).toBe("arpeggio");
    expect(code?.startsWith("0")).toBe(true);
  });

  it("Enter and From cursor play the song from the cursor, Play pauses and resumes, Escape stops", async () => {
    typeKeys(
      "Home",
      "ArrowDown",
      "ArrowDown",
      "ArrowDown",
      "ArrowDown",
      "ArrowDown"
    );
    const mark = sent.length;
    typeKeys("Enter");
    const song = sentSince(mark, "loadSong").at(-1);
    expect(song?.song).toEqual(songValue(SONG));
    expect(sentSince(mark, "play")).toMatchObject([{ order: 0, row: 5 }]);
    expect(engineMod.engine.playing).toBe(true);
    press(document.getElementById("gPlay"));
    expect(sentSince(mark).map((m) => m.type)).toContain("pause");
    expect(engineMod.engine.playing).toBe(false);
    press(document.getElementById("gPlay"));
    expect(engineMod.engine.playing).toBe(true);
    key("Escape");
    expect(sentSince(mark).at(-1)?.type).toBe("stop");
    expect(engineMod.engine.playing).toBe(false);
    const second = sent.length;
    press(document.getElementById("gHere"));
    expect(sentSince(second, "play")).toMatchObject([{ order: 0, row: 5 }]);
    key("Escape");
    await settle(30);
  });

  it("muting a channel marks it in the song and the engine is handed the muted song", async () => {
    const mark = sent.length;
    // the header is rebuilt after each change, so the button is looked up again each time
    const mute = () =>
      document.querySelector('#gHead .tch[data-ch="1"] [data-act="mute"]');
    press(mute());
    expect(songValue(SONG).channels[1]?.muted).toBe(true);
    expect(
      await until(() =>
        sentSince(mark, "loadSong").some(
          (m) => (m.song as Song).channels[1]?.muted === true
        )
      )
    ).toBe(true);
    const unmark = sent.length;
    press(mute());
    expect(songValue(SONG).channels[1]?.muted).toBe(false);
    expect(
      await until(() =>
        sentSince(unmark, "loadSong").some(
          (m) => (m.song as Song).channels[1]?.muted === false
        )
      )
    ).toBe(true);
  });

  it("solo tells the engine, dims the other channels, and is cleared when the editor closes", async () => {
    const mark = sent.length;
    press(document.querySelector('#gHead .tch[data-ch="2"] [data-act="solo"]'));
    expect(sentSince(mark, "setChannel")).toMatchObject([
      { channel: 2, solo: true },
    ]);
    const dimmed = [...document.querySelectorAll("#gHead .tch")].map((el) =>
      el.classList.contains("dimmed")
    );
    expect(dimmed.map((d, i) => (i === 2 ? !d : d))).toEqual(
      dimmed.map(() => true)
    );
    await go("#/pads", () => document.querySelector(".pad[data-id]") !== null);
    expect(sentSince(mark, "setChannel").at(-1)).toMatchObject({
      channel: 2,
      solo: false,
    });
    await goSong(SONG);
  });

  it("the channel volume slider reaches the engine and the song", () => {
    press(document.querySelector('#gHead .tch[data-ch="2"]'));
    const mark = sent.length;
    // the first Volume is the song's master, the second the selected channel's
    setRange(field(insp(), "Volume", 1), 0.35);
    expect(songValue(SONG).channels[2]?.volume).toBe(0.35);
    expect(sentSince(mark, "setChannel")).toMatchObject([
      { channel: 2, volume: 0.35 },
    ]);
  });

  it("tempo is clamped to 20 to 400, saved in the song and sent to the engine", () => {
    const tempo = document.getElementById("gTempo") as HTMLInputElement;
    const mark = sent.length;
    for (const [typed, want] of [
      ["150", 150],
      ["9999", 400],
      ["5", 20],
    ] as const) {
      tempo.value = typed;
      fire(tempo, "change");
      expect(songValue(SONG).tempo).toBe(want);
    }
    expect(sentSince(mark, "setTempo").map((m) => m.tempo)).toEqual([
      150, 400, 20,
    ]);
  });

  it("a channel written as MML comes back as the same rows in the tracker", async () => {
    await makeSong("mml-song");
    await goSong("mml-song");
    typeKeys("z", "s", "x", "1");
    const track = () => {
      const s = songValue("mml-song");
      return s.patterns["pattern-1"]?.tracks[s.channels[0]?.id as string] ?? [];
    };
    const before = clone(track());
    expect(before.map((r) => r.note)).toEqual([
      lowestNote(),
      lowestNote() + 1,
      lowestNote() + 2,
      "off",
    ]);
    const head = document.getElementById("gHead") as HTMLElement;
    press(head.querySelector('.tch[data-ch="0"] [data-act="mml"]'));
    const [ch0] = songValue("mml-song").channels;
    expect(ch0?.mml).toEqual(expect.any(String));
    expect(track()).toEqual([]);
    expect(toast()).toContain("is now written in MML");
    expect(document.querySelector<HTMLTextAreaElement>(".mml-ta")?.value).toBe(
      ch0?.mml
    );
    press(document.querySelector(".mml-top .btn"));
    expect(songValue("mml-song").channels[0]?.mml).toBeNull();
    expect(track()).toEqual(before);
  });

  /* MML has no release, so the conversion notes the release rows in a trailing MML comment and converting back turns the
     note offs on those rows into releases again. */
  it("a release row survives a trip through MML", async () => {
    await makeSong("release-song");
    await goSong("release-song");
    typeKeys("z", "`");
    const track = () => {
      const s = songValue("release-song");
      return s.patterns["pattern-1"]?.tracks[s.channels[0]?.id as string] ?? [];
    };
    const head = document.getElementById("gHead") as HTMLElement;
    press(head.querySelector('.tch[data-ch="0"] [data-act="mml"]'));
    press(document.querySelector(".mml-top .btn"));
    expect(track().map((r) => r.note)).toEqual([lowestNote(), "release"]);
  });

  it("typing MML changes the channel's text, and bad MML is reported", async () => {
    await goSong(SONG);
    const head = document.getElementById("gHead") as HTMLElement;
    press(head.querySelector('.tch[data-ch="1"] [data-act="mml"]'));
    const ta = document.querySelector<HTMLTextAreaElement>(
      ".mml-ta"
    ) as HTMLTextAreaElement;
    ta.value = "o4 l8 c d e f";
    fire(ta, "input");
    expect(document.querySelector(".mml-msg")?.textContent).toBe("ok");
    expect(
      await until(() => songValue(SONG).channels[1]?.mml === "o4 l8 c d e f")
    ).toBe(true);
    // the panel may have been rebuilt by the edit
    const again = document.querySelector<HTMLTextAreaElement>(
      ".mml-ta"
    ) as HTMLTextAreaElement;
    again.value = "o4 l8 c d e f zz";
    fire(again, "input");
    expect(document.querySelector(".mml-msg")?.classList.contains("bad")).toBe(
      true
    );
    expect(document.querySelector(".mml-msg")?.textContent).toContain(
      'unknown command "z"'
    );
    press(document.querySelector(".mml-top .btn"));
    expect(songValue(SONG).channels[1]?.mml).toBeNull();
    expect(rowsOf(1).length).toBeGreaterThan(0);
  });

  it("every control of the song inspector edits the song", async () => {
    await makeSong("inspector-song", {}, 3);
    await goSong("inspector-song");
    const { dead, tested } = unwired(insp, () =>
      JSON.stringify(songValue("inspector-song"))
    );
    expect(tested).toBeGreaterThanOrEqual(6);
    expect(dead).toEqual([]);
  });

  describe("the order list", () => {
    const orderBtn = (label: string) =>
      [...document.querySelectorAll<HTMLElement>("#gOrder .btn")].find(
        (b) => b.textContent === label
      ) ?? null;
    const order = (id: string) => songValue(id).order;
    const chips = () => [
      ...document.querySelectorAll<HTMLElement>("#gOrder .ochip"),
    ];
    const open = async (id: string, orders: number, loop: number | null) => {
      await makeSong(id, { loop }, orders);
      await goSong(id);
    };

    it("New adds an empty pattern of the same length after this one, Copy duplicates it", async () => {
      await open("order-new", 2, 0);
      typeKeys("z", "x");
      press(orderBtn("New"));
      let s = songValue("order-new");
      const added = s.order[1] as string;
      expect(s.order).toEqual(["pattern-1", added, "pattern-2"]);
      expect(["pattern-1", "pattern-2"]).not.toContain(added);
      expect(s.patterns[added]).toEqual({ length: 64, tracks: {} });
      press(chips()[0] as HTMLElement);
      press(orderBtn("Copy"));
      s = songValue("order-new");
      expect(s.order).toHaveLength(4);
      const copyId = s.order[1] as string;
      expect(copyId).not.toBe("pattern-1");
      expect(s.patterns[copyId]).toEqual(s.patterns["pattern-1"]);
      expect(Object.keys(s.patterns[copyId]?.tracks ?? {})).toHaveLength(1);
    });

    it("Loop marks this pattern as where the song loops back to, and again turns the loop off", async () => {
      await open("order-loop", 3, null);
      press(chips()[1] as HTMLElement);
      press(orderBtn("Loop"));
      expect(songValue("order-loop").loop).toBe(1);
      press(orderBtn("Loop"));
      expect(songValue("order-loop").loop).toBeNull();
    });

    it("Left and Right move the pattern, a drag reorders, and the select changes which pattern a step plays", async () => {
      await open("order-move", 3, 0);
      press(chips()[1] as HTMLElement);
      press(orderBtn("Left"));
      expect(order("order-move")).toEqual([
        "pattern-2",
        "pattern-1",
        "pattern-3",
      ]);
      press(orderBtn("Left"));
      expect(order("order-move")).toEqual([
        "pattern-2",
        "pattern-1",
        "pattern-3",
      ]);
      press(orderBtn("Right"));
      press(orderBtn("Right"));
      press(orderBtn("Right"));
      expect(order("order-move")).toEqual([
        "pattern-1",
        "pattern-3",
        "pattern-2",
      ]);

      const data = new Map<string, string>();
      const dt = {
        getData: (k: string) => data.get(k) ?? "",
        setData: (k: string, v: string) => data.set(k, v),
      };
      const drag = (type: string, el: Element) => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        (e as unknown as { dataTransfer: unknown }).dataTransfer = dt;
        el.dispatchEvent(e);
      };
      drag("dragstart", chips()[2] as Element);
      drag("dragover", chips()[0] as Element);
      drag("drop", chips()[0] as Element);
      expect(order("order-move")).toEqual([
        "pattern-2",
        "pattern-1",
        "pattern-3",
      ]);

      const sel = document.querySelector<HTMLSelectElement>(
        "#gOrder .pat-sel"
      ) as HTMLSelectElement;
      sel.value = "pattern-3";
      fire(sel, "change");
      expect(order("order-move")[0]).toBe("pattern-3");
    });

    it("Remove takes a step out of the order, and the last step stays", async () => {
      await open("order-remove", 2, 0);
      press(orderBtn("Remove"));
      expect(order("order-remove")).toEqual(["pattern-2"]);
      press(orderBtn("Remove"));
      expect(order("order-remove")).toEqual(["pattern-2"]);
      expect(toast()).toBe("A song needs at least one pattern");
    });

    /* The song's loop is an index into the order, so editing the order around it has to carry the index along: the song
       keeps looping back to the pattern that was marked. */
    it("adding a pattern before the loop target keeps the loop on the same pattern", async () => {
      await open("order-loop-new", 2, 1);
      press(chips()[0] as HTMLElement);
      press(orderBtn("New"));
      const s = songValue("order-loop-new");
      expect(s.order[s.loop as number]).toBe("pattern-2");
    });

    it("removing a pattern before the loop target keeps the loop on the same pattern", async () => {
      await open("order-loop-remove", 3, 1);
      press(chips()[0] as HTMLElement);
      press(orderBtn("Remove"));
      const s = songValue("order-loop-remove");
      expect(s.order[s.loop as number]).toBe("pattern-2");
    });

    it("moving a pattern across the loop target keeps the loop on the same pattern", async () => {
      await open("order-loop-move", 3, 1);
      press(chips()[0] as HTMLElement);
      press(orderBtn("Right"));
      const s = songValue("order-loop-move");
      expect(s.order[s.loop as number]).toBe("pattern-2");
    });
  });

  describe("the pattern length", () => {
    const row = (r: number, note: number) => ({
      fx: [],
      inst: null,
      note,
      row: r,
      vol: null,
    });
    const lenIn = () => document.getElementById("gLen") as HTMLInputElement;
    const setLength = (v: string) => {
      lenIn().value = v;
      fire(lenIn(), "change");
    };
    const trackRows = (id: string) => {
      const s = songValue(id);
      const p = s.patterns["pattern-1"];
      return s.channels.map((c) => (p?.tracks[c.id] ?? []).map((r) => r.row));
    };

    it("shortening a pattern drops the notes that no longer fit, in every channel, and keeps the rest", async () => {
      const [a, b] = defaultSong(project().project.chip).channels.map(
        (c) => c.id
      ) as [string, string];
      await makeSong("len-trim", {
        patterns: {
          "pattern-1": {
            length: 64,
            tracks: {
              [a]: [row(0, 60), row(9, 62), row(10, 64), row(40, 65)],
              [b]: [row(3, 48), row(12, 50)],
            },
          },
        },
      });
      await goSong("len-trim");
      expect(document.querySelectorAll(".trow")).toHaveLength(64);
      setLength("16");
      expect(songValue("len-trim").patterns["pattern-1"]?.length).toBe(16);
      expect(trackRows("len-trim").slice(0, 2)).toEqual([
        [0, 9, 10],
        [3, 12],
      ]);
      expect(document.querySelectorAll(".trow")).toHaveLength(16);
      // a note on row 10 needs a length of 11: at 10 it goes, the one on row 9 stays
      setLength("10");
      expect(trackRows("len-trim").slice(0, 2)).toEqual([[0, 9], [3]]);
      // growing the pattern again does not bring them back
      setLength("64");
      expect(trackRows("len-trim").slice(0, 2)).toEqual([[0, 9], [3]]);
      expect(document.querySelectorAll(".trow")).toHaveLength(64);
    });

    it("keeps a pattern between 1 and 256 rows long and shows the length it kept", async () => {
      await makeSong("len-clamp");
      await goSong("len-clamp");
      setLength("1000");
      expect(songValue("len-clamp").patterns["pattern-1"]?.length).toBe(256);
      expect(lenIn().value).toBe("256");
      setLength("-4");
      expect(songValue("len-clamp").patterns["pattern-1"]?.length).toBe(1);
      expect(lenIn().value).toBe("1");
      setLength("12.6");
      expect(songValue("len-clamp").patterns["pattern-1"]?.length).toBe(13);
    });
  });

  describe("while the song plays", () => {
    const SONG_P = "playhead-test";
    const ROW = 20;
    let tickAt = 1_000_000;
    /** The engine reports where the song is (or that it stopped), and the visual loop draws one frame. */
    const engineAt = (pos: { order: number; row: number } | null) => {
      engineMod.engine.playing = pos !== null;
      engineMod.engine.position = pos && { ...pos, pulse: 0, tick: 0 };
      tickAt += 20;
      loopMod.tickOnce(tickAt);
    };
    const playingRows = () =>
      [...document.querySelectorAll<HTMLElement>(".trow.play")].map((el) =>
        Number(el.dataset.r)
      );
    const chipsOf = () => [
      ...document.querySelectorAll<HTMLElement>("#gOrder .ochip"),
    ];
    const playingChips = () =>
      chipsOf().flatMap((el, i) =>
        el.classList.contains("playing") ? [i] : []
      );
    const shownChip = () =>
      chipsOf().findIndex((el) => el.classList.contains("cur"));
    const follow = (on: boolean) => {
      const box = document.getElementById("gFollow") as HTMLInputElement;
      box.checked = on;
      fire(box, "change");
    };
    beforeAll(async () => {
      await makeSong(SONG_P, {}, 2);
    });
    afterEach(() => {
      engineAt(null);
      follow(true);
    });

    it("marks the row and the pattern that are playing, and clears both when the song stops", async () => {
      await goSong(SONG_P);
      expect(playingRows()).toEqual([]);
      expect(playingChips()).toEqual([]);
      engineAt({ order: 0, row: 5 });
      expect(playingRows()).toEqual([5]);
      expect(playingChips()).toEqual([0]);
      engineAt({ order: 0, row: 6 });
      expect(playingRows()).toEqual([6]);
      engineAt(null);
      expect(playingRows()).toEqual([]);
      expect(playingChips()).toEqual([]);
    });

    it("flashes a row as the song reaches it, and only for a moment", async () => {
      await goSong(SONG_P);
      engineAt({ order: 0, row: 8 });
      const el = document.querySelector(".trow.play") as HTMLElement;
      expect(el.classList.contains("flash")).toBe(true);
      await settle(150);
      expect(el.classList.contains("play")).toBe(true);
      expect(el.classList.contains("flash")).toBe(false);
    });

    it("with follow off, a pattern that is not on screen is marked in the order list and no row is", async () => {
      await goSong(SONG_P);
      follow(false);
      engineAt({ order: 1, row: 3 });
      expect(playingChips()).toEqual([1]);
      expect(shownChip()).toBe(0);
      expect(playingRows()).toEqual([]);
      // when the song comes round to the pattern on screen, its row is marked again
      engineAt({ order: 0, row: 3 });
      expect(playingChips()).toEqual([0]);
      expect(playingRows()).toEqual([3]);
    });

    it("with follow on, the grid moves to the pattern that plays, unless the song has no such pattern", async () => {
      await goSong(SONG_P);
      follow(true);
      engineAt({ order: 1, row: 3 });
      expect(shownChip()).toBe(1);
      expect(playingChips()).toEqual([1]);
      expect(playingRows()).toEqual([3]);
      // the song was cut short while it played: the engine is on a step the document no longer has
      engineAt({ order: 7, row: 0 });
      expect(shownChip()).toBe(1);
    });

    it("with follow on, scrolls the grid to keep the playing row about a third of the way down the visible rows", async () => {
      await goSong(SONG_P);
      // happy-dom lays nothing out: a 400 px viewport under a 40 px header shows 18 rows of 20 px
      Object.defineProperty(tracker(), "clientHeight", {
        configurable: true,
        value: 400,
      });
      Object.defineProperty(document.getElementById("gHead"), "offsetHeight", {
        configurable: true,
        value: 40,
      });
      tracker().scrollTop = 0;
      follow(true);
      // a third of 18 rows is 6: the row that plays has 6 rows above it
      engineAt({ order: 0, row: 30 });
      expect(tracker().scrollTop).toBe(24 * ROW);
      // near the top there is nothing to scroll
      engineAt({ order: 0, row: 4 });
      expect(tracker().scrollTop).toBe(0);
      follow(false);
      engineAt({ order: 0, row: 50 });
      expect(tracker().scrollTop).toBe(0);
    });
  });

  it("changing the song's chip gives it that chip's channels and keeps the notes of channels it still has", async () => {
    await makeSong("chip-song");
    await goSong("chip-song");
    typeKeys("z", "x");
    const before = clone(
      songValue("chip-song").patterns["pattern-1"]?.tracks[
        songValue("chip-song").channels[0]?.id as string
      ]
    );
    const chip = field<HTMLSelectElement>(insp(), "Chip");
    const other = [...chip.options].find(
      (o) => !o.disabled && o.value !== chip.value && o.value !== "custom"
    )?.value as string;
    chip.value = other;
    fire(chip, "change");
    const s = songValue("chip-song");
    expect(s.chip).toBe(other);
    expect(s.channels.map((c) => c.id)).toEqual(
      chipProfile(other as never).channels.map((c) => c.id)
    );
    const kept = s.channels.find(
      (c) => c.id === songValue("chip-song").channels[0]?.id
    );
    if (kept) {
      expect(s.patterns["pattern-1"]?.tracks[kept.id]).toEqual(before);
    }
  });
});

describe("the instrument editor", () => {
  const first = () =>
    project().list("instrument")[0] as ReturnType<
      DocsMod["project"]["list"]
    >[number];
  const octave = () => Number(document.getElementById("iOct")?.textContent);
  const channelOf = (id: string) =>
    engineMod.engine.previewChannelFor(instValue(id).kind);
  const noteOns = (mark: number) =>
    sentSince(mark, "noteOn").map((m) => [m.instrument, m.note, m.channel]);

  it("the computer keys hold a note on this instrument until the key comes up", async () => {
    const { id } = first();
    await goInstrument(id);
    const lo = (octave() + 1) * 12;
    const ch = channelOf(id);
    const mark = sent.length;
    key("z");
    key("z");
    key("q");
    expect(noteOns(mark)).toEqual([
      [id, lo, ch],
      [id, lo + 12, ch],
    ]);
    // the engine has the instrument as the project holds it
    expect(
      sentSince(0, "setInstrument")
        .filter((m) => m.id === id)
        .at(-1)?.instrument
    ).toEqual(instValue(id));
    // a channel holds one note: z was replaced by q, so letting go of z leaves q sounding and letting go of q ends it
    const released = sent.length;
    document.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, key: "z" })
    );
    expect(sentSince(released, "noteOff")).toEqual([]);
    document.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, key: "q" })
    );
    expect(sentSince(released, "noteOff")).toMatchObject([{ channel: ch }]);
    key("=");
    expect(octave()).toBe(lo / 12);
    key("-");
    key("-");
    expect(octave()).toBe(lo / 12 - 2);
    key("-");
    key("=");
    key("=");
    expect(octave()).toBe(lo / 12 - 1);
  });

  it("the piano keys play the note under the pointer, black keys included", async () => {
    const { id } = first();
    await goInstrument(id);
    const kb = document.getElementById("iKeys") as HTMLElement;
    const lo = (octave() + 1) * 12;
    const mark = sent.length;
    const at = (type: string, x: number, y: number) =>
      kb.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: y,
          pointerId: 3,
        })
      );
    kb.setPointerCapture = () => undefined;
    for (const [x, y] of [
      [5, 50],
      [24, 10],
      [331, 50],
    ] as const) {
      at("pointerdown", x, y);
      at("pointerup", x, y);
    }
    expect(noteOns(mark)).toEqual([
      [id, lo, channelOf(id)],
      [id, lo + 1, channelOf(id)],
      [id, lo + 23, channelOf(id)],
    ]);
    expect(sentSince(mark, "noteOff")).toHaveLength(3);
  });

  it("dragging across the piano lets go of the key it leaves and plays the key it reaches", async () => {
    const { id } = first();
    await goInstrument(id);
    const kb = document.getElementById("iKeys") as HTMLElement;
    const lo = (octave() + 1) * 12;
    const ch = channelOf(id);
    kb.setPointerCapture = () => undefined;
    const at = (type: string, x: number, buttons: number) =>
      kb.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          buttons,
          clientX: x,
          clientY: 50,
          pointerId: 4,
        })
      );
    const mark = sent.length;
    // keys are 24 px wide: C is 0 to 24, D is 24 to 48, E is 48 to 72 (below the black keys)
    at("pointerdown", 5, 1);
    // still on C: nothing new is played
    at("pointermove", 20, 1);
    expect(noteOns(mark)).toEqual([[id, lo, ch]]);
    expect(sentSince(mark, "noteOff")).toHaveLength(0);
    // onto D: C is let go and D sounds
    at("pointermove", 30, 1);
    expect(noteOns(mark)).toEqual([
      [id, lo, ch],
      [id, lo + 2, ch],
    ]);
    expect(sentSince(mark, "noteOff")).toHaveLength(1);
    // a pointer with no button down is only passing over the keys
    at("pointermove", 55, 0);
    expect(noteOns(mark)).toHaveLength(2);
    expect(sentSince(mark, "noteOff")).toHaveLength(1);
    at("pointerup", 30, 0);
    expect(sentSince(mark, "noteOff")).toHaveLength(2);
    // with no key held, moving does nothing at all
    at("pointermove", 55, 1);
    expect(noteOns(mark)).toHaveLength(2);
  });

  it("Play sounds the test note on this instrument and lets it go after the test length", async () => {
    const { id } = first();
    await goInstrument(id);
    const note = Number(
      (document.getElementById("iNote") as HTMLSelectElement).value
    );
    const mark = sent.length;
    press(document.getElementById("iPlay"));
    expect(noteOns(mark)).toEqual([[id, note, channelOf(id)]]);
    expect(sentSince(mark, "noteOff")).toEqual([]);
    expect(
      await until(() => sentSince(mark, "noteOff").length === 1, 3000)
    ).toBe(true);
  });

  it("a slider hands the engine the edited instrument and the store keeps it", async () => {
    const { id, path } = first();
    const original = clone(instValue(id));
    const mark = sent.length;
    const attack = field(insp(), "Attack");
    const v = Number(attack.max) / 2;
    setRange(attack, v);
    expect(instValue(id).envelope.attack).toBe(Number(attack.value));
    expect(instValue(id).envelope.attack).not.toBe(original.envelope.attack);
    const handed = sentSince(mark, "setInstrument").at(-1) as unknown as {
      id: string;
      instrument: Instrument;
    };
    expect(handed.id).toBe(id);
    expect(handed.instrument.envelope.attack).toBe(
      instValue(id).envelope.attack
    );
    const doc = project().get("instrument", id);
    expect(await until(() => doc?.dirty === false, 4000)).toBe(true);
    expect((await stored<Instrument>(path)).envelope.attack).toBe(
      instValue(id).envelope.attack
    );
    project().edit<Instrument>(doc as never, () => clone(original));
  });

  it("every control of every instrument edits the instrument", async () => {
    const failures: string[] = [];
    let tested = 0;
    for (const d of project().list("instrument")) {
      // biome-ignore lint/performance/noAwaitInLoops: one editor at a time, each is mounted and unmounted in order
      await goInstrument(d.id);
      const original = clone(instValue(d.id));
      const snap = () => JSON.stringify(instValue(d.id));
      for (const root of [view, insp]) {
        const result = unwired(root, snap);
        tested += result.tested;
        if (result.dead.length) {
          failures.push(`${d.id}: ${result.dead.join(", ")}`);
        }
      }
      project().edit<Instrument>(d as never, () => clone(original));
    }
    expect(tested).toBeGreaterThan(30);
    expect(failures).toEqual([]);
  });

  it("each macro bar editor switches its macro on, draws it and switches it off in the instrument", async () => {
    const { id } = first();
    await goInstrument(id);
    const original = clone(instValue(id));
    const editors = [
      ...view().querySelectorAll<HTMLElement>(".macro:not(.off)"),
    ];
    expect(editors.length).toBeGreaterThan(2);
    // an arpeggio mode of "offset" is the default and stays once the arpeggio has been on
    const macros = () =>
      JSON.stringify(
        Object.entries(instValue(id).macros).filter(
          ([k]) => k !== "arpeggioMode"
        )
      );
    // the bars measure themselves when they draw
    loopMod.tickOnce(performance.now() + 100);
    const dead: string[] = [];
    for (const ed of editors) {
      const name = ed.querySelector(".pxh")?.textContent ?? "?";
      const switchBox = ed.querySelector<HTMLInputElement>(
        ".tgl input"
      ) as HTMLInputElement;
      if (switchBox.checked) {
        switchBox.click();
      }
      const off = macros();
      switchBox.click();
      const enabled = macros();
      if (enabled === off) {
        dead.push(`${name}: switch on`);
      }
      const cv = ed.querySelector("canvas") as HTMLCanvasElement;
      cv.setPointerCapture = () => undefined;
      const at = (type: string, x: number, y: number) =>
        cv.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            clientX: x,
            clientY: y,
            pointerId: 5,
          })
        );
      at("pointerdown", 30, 20);
      at("pointermove", 90, 60);
      at("pointermove", 150, 5);
      at("pointerup", 150, 5);
      if (macros() === enabled) {
        dead.push(`${name}: draw`);
      }
      switchBox.click();
      if (macros() !== off) {
        dead.push(`${name}: switch off`);
      }
    }
    project().edit<Instrument>(project().get("instrument", id) as never, () =>
      clone(original)
    );
    expect(dead).toEqual([]);
  });
});

describe("the analysis view", () => {
  const written: string[] = [];
  beforeAll(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });
  });
  const card = (label: string) =>
    [...document.querySelectorAll<HTMLElement>(".stat")]
      .find((el) => el.querySelector("small")?.textContent === label)
      ?.querySelector(".val")?.textContent;
  const measured = async (hash: string) => {
    await go(hash, () => document.getElementById("aRerun") !== null);
    expect(
      await until(() => document.querySelectorAll(".stat").length > 3, 30_000)
    ).toBe(true);
    // the numbers count up before they settle
    await settle(700);
  };
  /** The analysis JSON the Copy button puts on the clipboard. */
  const copied = async () => {
    const n = written.length;
    press(document.getElementById("aCopy"));
    expect(await until(() => written.length > n)).toBe(true);
    return JSON.parse(written.at(-1) as string) as {
      duration: number;
      frames: number;
      peakDb: number;
      sampleRate: number;
    };
  };

  it("measures the sound that was asked for, and the cards show what the JSON says", async () => {
    await measured("#/analysis/sfx/coin");
    const a = await copied();
    const { renderSfx } = await import("../src/lib/core.ts");
    const heard = renderSfx(sfxValue("coin"), {
      master: project().project.master,
      sampleRate: a.sampleRate,
    });
    expect(a.frames).toBe(heard.frames);
    expect(card("Peak")).toBe(`${a.peakDb.toFixed(1)} dB`);
    expect(card("Duration")).toBe(`${a.duration.toFixed(2)} s`);
    expect(card("Loop seam")).toBeUndefined();
  });

  it("measuring again after an edit follows the edit: half the volume is 6 dB quieter", async () => {
    const before = await copied();
    const original = clone(sfxValue("coin"));
    project().edit<Sfx>(project().get("sfx", "coin") as never, (d) => {
      d.volume = original.volume / 2;
    });
    press(document.getElementById("aRerun"));
    expect(
      await until(
        () => card("Peak") !== `${before.peakDb.toFixed(1)} dB`,
        10_000
      )
    ).toBe(true);
    await settle(700);
    const after = await copied();
    expect(before.peakDb - after.peakDb).toBeGreaterThan(5);
    expect(before.peakDb - after.peakDb).toBeLessThan(7);
    project().edit<Sfx>(project().get("sfx", "coin") as never, () =>
      clone(original)
    );
  });

  it("a song's analysis adds the loop seam", async () => {
    await measured("#/analysis/song/starter-theme");
    expect(card("Loop seam")).toEqual(expect.any(String));
    const a = await copied();
    expect(a.duration).toBeGreaterThan(5);
  });

  it("a pitched instrument is measured on middle C", async () => {
    const pitched = project()
      .list("instrument")
      .find((d) =>
        ["pulse", "triangle"].includes((d.value as Instrument).kind)
      );
    await measured(`#/analysis/instrument/${pitched?.id}`);
    const hz = Number(/(\d+(?:\.\d+)?) Hz$/.exec(card("Pitch") ?? "")?.[1]);
    expect(hz).toBeGreaterThan(255);
    expect(hz).toBeLessThan(268);
  });

  describe("the playhead over the images", () => {
    const BAR = "rgba(236,231,218,0.9)";
    const times = <T>(n: number, v: T) => Array.from({ length: n }, () => v);
    const bars = () => filledRects.filter((r) => r.style === BAR && r.w === 2);
    /** The page's own clock, which the playhead reads, held where the test puts it. */
    let at: number | null = null;
    const realNow = performance.now.bind(performance);
    beforeAll(() => {
      vi.spyOn(performance, "now").mockImplementation(() => at ?? realNow());
    });
    afterAll(() => {
      vi.restoreAllMocks();
    });
    /** Show the images 1000 px wide (happy-dom lays nothing out), start playing at 10 s, and draw a frame `s` seconds in. */
    const frameAt = (s: number) => {
      at = 10_000 + s * 1000;
      filledRects.length = 0;
      loopMod.tickOnce(at);
    };
    const start = async () => {
      await measured("#/analysis/sfx/coin");
      for (const el of document.querySelectorAll(".an-frame")) {
        Object.defineProperty(el, "clientWidth", {
          configurable: true,
          value: 1000,
        });
        Object.defineProperty(el, "clientHeight", {
          configurable: true,
          value: 100,
        });
      }
      const { duration } = await copied();
      at = 10_000;
      press(document.getElementById("aPlay"));
      return duration;
    };

    it("crosses every image from its left margin to its right margin over the length of the sound, then is gone", async () => {
      const duration = await start();
      const images = document.querySelectorAll(".an-frame").length;
      expect(images).toBeGreaterThan(1);
      // the plot spans 6.5% to 98.5% of the image: 65 and 985 px of 1000
      frameAt(0);
      expect(bars().map((r) => r.x)).toEqual(times(images, 65));
      frameAt(duration / 2);
      expect(bars().map((r) => r.x)).toEqual(times(images, 525));
      expect(bars().every((r) => r.h === 100)).toBe(true);
      frameAt(duration);
      expect(bars().map((r) => r.x)).toEqual(times(images, 985));
      // the overlay is as big as the image it sits on
      expect(
        [...document.querySelectorAll<HTMLCanvasElement>(".an-ph")].map((c) => [
          c.width,
          c.height,
        ])
      ).toEqual(times(images, [1000, 100]));
      // past the end it draws nothing, and stays quiet even if the clock is read from the middle again
      frameAt(duration + 1);
      expect(bars()).toEqual([]);
      frameAt(duration / 2);
      expect(bars()).toEqual([]);
      at = null;
    });

    it("stops drawing when the view is left", async () => {
      const duration = await start();
      frameAt(duration / 2);
      expect(bars().length).toBeGreaterThan(0);
      at = null;
      await go(
        "#/pads",
        () => document.querySelector(".pad[data-id]") !== null
      );
      frameAt(duration / 2);
      expect(bars()).toEqual([]);
      at = null;
      engineMod.engine.stopAll();
    });
  });

  it("a sound that does not exist says so, with a way back", async () => {
    await go(
      "#/analysis/sfx/missing",
      () => document.querySelector(".empty-state") !== null
    );
    expect(document.querySelector(".empty-state")?.textContent).toContain(
      "missing"
    );
    expect(
      document
        .querySelector<HTMLAnchorElement>(".empty-state a")
        ?.getAttribute("href")
    ).toBe("#/pads");
  });
});

describe("keyboard shortcuts", () => {
  const mod = (
    k: string,
    init: KeyboardEventInit = {},
    el: Element = document.body
  ) => key(k, { ctrlKey: true, ...init }, el);

  it("Ctrl+Shift+A opens the analysis of the sound or song being edited, and says no for an instrument", async () => {
    await goSfx("coin");
    mod("a", { shiftKey: true });
    expect(location.hash).toBe("#/analysis/sfx/coin");
    await goSong("starter-theme");
    mod("a", { shiftKey: true });
    expect(location.hash).toBe("#/analysis/song/starter-theme");
    const { id } = project().list("instrument")[0] as { id: string };
    await goInstrument(id);
    mod("a", { shiftKey: true });
    expect(location.hash).toBe(`#/instrument/${id}`);
    expect(toast()).toBe("Analysis is for sound effects and songs");
  });

  it("Ctrl+E goes to the export card of the project page", async () => {
    await goSfx("coin");
    mod("e");
    expect(location.hash).toBe("#/project?export=1");
    expect(
      await until(
        () =>
          document.getElementById("pExport")?.classList.contains("spot") ===
          true
      )
    ).toBe(true);
  });

  it("undo is left to a text field while typing in it, and is the document's otherwise", async () => {
    await goSfx("coin");
    const original = sfxValue("coin").volume;
    setRange(field(insp(), "Volume"), 0.21);
    expect(sfxValue("coin").volume).toBe(0.21);
    mod("z", {}, document.getElementById("sName") as Element);
    expect(sfxValue("coin").volume).toBe(0.21);
    mod("z");
    expect(sfxValue("coin").volume).toBe(original);
  });

  it("the bracket keys step through sounds, then songs, then instruments, and wrap around", async () => {
    const all = [
      ...project().list("sfx"),
      ...project().list("song"),
      ...project().list("instrument"),
    ];
    const route = (d: (typeof all)[number]) => `#/${d.kind}/${d.id}`;
    const first = all[0] as (typeof all)[number];
    const last = all.at(-1) as (typeof all)[number];
    await go(route(first), () => location.hash === route(first));
    // each key is pressed once the view it lands on has mounted, which is what it steps from
    const step = async (k: string, to: (typeof all)[number]) => {
      key(k);
      expect(await until(() => location.hash === route(to))).toBe(true);
      await settle(60);
    };
    await step("]", all[1] as never);
    await step("[", first);
    await step("[", last);
    await step("]", first);
  });
});

describe("the project view", () => {
  const code = () => document.getElementById("pCode")?.textContent ?? "";
  const clipboard: string[] = [];
  let copyFails = false;
  beforeAll(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          if (copyFails) {
            return Promise.reject(new Error("denied"));
          }
          clipboard.push(text);
          return Promise.resolve();
        },
      },
    });
  });

  /** Run `act` while downloads are recorded, in the order they were started, with the bytes each one carried. It
      waits for `expected` downloads to have started. */
  async function downloading(act: () => Promise<void> | void, expected = 1) {
    const made: { bytes: Uint8Array; name: string }[] = [];
    const blobs: Blob[] = [];
    const { createObjectURL } = URL;
    const { click } = HTMLAnchorElement.prototype;
    URL.createObjectURL = (b: Blob | MediaSource) => {
      blobs.push(b as Blob);
      return `blob:test-${blobs.length}`;
    };
    const names: string[] = [];
    HTMLAnchorElement.prototype.click = function recorded(
      this: HTMLAnchorElement
    ) {
      names.push(this.download);
    };
    try {
      await act();
      await until(() => names.length >= expected, 5000);
      const bytes = await Promise.all(
        blobs.map(async (b) => new Uint8Array(await b.arrayBuffer()))
      );
      for (const [i, name] of names.entries()) {
        made.push({ bytes: bytes[i] as Uint8Array, name });
      }
    } finally {
      URL.createObjectURL = createObjectURL;
      HTMLAnchorElement.prototype.click = click;
    }
    return made;
  }

  const stale = () =>
    [...document.querySelectorAll<HTMLElement>(".stale-chip")].map((c) => [
      c.querySelector("span")?.textContent,
      c.querySelector("small")?.textContent,
    ]);

  it("the master volume and limiter reach the engine, the project and the store", async () => {
    await goProject();
    const was = clone(project().project.master);
    const mark = sent.length;
    setRange(field(view(), "Master volume"), 0.4);
    field(view(), "Limiter").click();
    expect(project().project.master).toEqual({
      limiter: !was.limiter,
      volume: 0.4,
    });
    expect(sentSince(mark, "setMaster")).toEqual([
      { type: "setMaster", volume: 0.4 },
      { limiter: !was.limiter, type: "setMaster" },
    ]);
    // autosave writes project.json by itself
    expect(await until(() => !project().projectDirty, 4000)).toBe(true);
    expect((await stored<{ master: unknown }>("project.json")).master).toEqual({
      limiter: !was.limiter,
      volume: 0.4,
    });
    setRange(field(view(), "Master volume"), was.volume);
    field(view(), "Limiter").click();
    expect(project().project.master).toEqual(was);
  });

  it("every setting of the project page edits the project", async () => {
    await goProject();
    const original = clone(project().project);
    const { dead, tested } = unwired(
      () => view(),
      () => JSON.stringify(project().project)
    );
    project().editProject(() => clone(original));
    expect(tested).toBeGreaterThan(10);
    expect(dead).toEqual([]);
  });

  it("the audio.ts preview lists every sound under the file it will have, and follows the format setting", async () => {
    await goProject();
    const sfx = project()
      .list("sfx")
      .map((d) => d.id);
    const songs = project()
      .list("song")
      .map((d) => d.id);
    const format = project().project.export.sfxFormat;
    for (const id of sfx) {
      expect(code()).toContain(`"${id}": "${id}.${format}"`);
    }
    for (const id of songs) {
      expect(code()).toContain(`"${id}": {`);
    }
    expect(document.getElementById("pPrevSub")?.textContent).toContain(
      `${sfx.length} sfx, ${songs.length} songs`
    );
    const select = field<HTMLSelectElement>(view(), "SFX format");
    select.value = "wav";
    fire(select, "change");
    expect(
      await until(() => code().includes(`"${sfx[0]}": "${sfx[0]}.wav"`))
    ).toBe(true);
    expect(code()).not.toContain(`"${sfx[0]}": "${sfx[0]}.${format}"`);
    select.value = format;
    fire(select, "change");
  });

  it("Copy puts the previewed audio.ts on the clipboard, and says so when the clipboard refuses", async () => {
    await goProject();
    press(document.getElementById("pCopy"));
    expect(await until(() => clipboard.length > 0)).toBe(true);
    expect(clipboard.at(-1)).toBe(code());
    expect(toast()).toBe("Copied audio.ts");
    copyFails = true;
    press(document.getElementById("pCopy"));
    expect(await until(() => toast().startsWith("Could not copy"))).toBe(true);
    copyFails = false;
  });

  it("an edited sound is listed as stale, first as unsaved and once saved as never exported, and its chip opens the sound", async () => {
    await goProject();
    const doc = project().list("sfx")[0] as ReturnType<
      DocsMod["project"]["list"]
    >[number];
    const original = clone(doc.value);
    project().edit<Sfx>(doc as never, (d) => {
      d.name = `${d.name}!`;
    });
    expect(
      await until(() =>
        stale().some(([id, why]) => id === doc.id && why === "unsaved changes")
      )
    ).toBe(true);
    expect(await until(() => doc.dirty === false, 4000)).toBe(true);
    expect(
      await until(() =>
        stale().some(([id, why]) => id === doc.id && why === "never exported")
      )
    ).toBe(true);
    press(
      [...document.querySelectorAll<HTMLElement>(".stale-chip")].find(
        (c) => c.querySelector("span")?.textContent === doc.id
      ) ?? null
    );
    expect(location.hash).toBe(`#/sfx/${doc.id}`);
    project().edit<Sfx>(doc as never, () => clone(original));
    await goProject();
  });

  it("exporting in the browser renders every sound to a WAV, writes the manifest and the events, and downloads one zip", async () => {
    project().editProject((p) => {
      p.export.sfxFormat = "wav";
      p.export.musicFormat = "wav";
      p.export.events = true;
      p.export.embed = true;
    }, "test");
    await goProject();
    const downloads = await downloading(async () => {
      press(document.getElementById("pGo"));
      // a second press while it runs does not start another export
      press(document.getElementById("pGo"));
      expect(
        await until(() => document.querySelector("#pOut .ok") !== null, 90_000)
      ).toBe(true);
    });
    expect(downloads.map((d) => d.name)).toEqual([
      `${project()
        .project.name.toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")}-audio.zip`,
    ]);
    const { readZip } = await import("../src/zip.ts");
    const entries = new Map(
      (await readZip(downloads[0]?.bytes as Uint8Array)).map((e) => [
        e.path,
        e.data,
      ])
    );
    const dir = "public/audio";
    const manifest = JSON.parse(
      new TextDecoder().decode(entries.get(`${dir}/manifest.json`))
    ) as {
      sampleRate: number;
      sfx: Record<string, { data?: unknown; duration: number; file: string }>;
      songs: Record<
        string,
        { data?: unknown; duration: number; events?: string; file: string }
      >;
    };
    const sfxIds = project()
      .list("sfx")
      .map((d) => d.id)
      .sort();
    expect(Object.keys(manifest.sfx).sort()).toEqual(sfxIds);
    expect(Object.keys(manifest.songs).sort()).toEqual(
      project()
        .list("song")
        .map((d) => d.id)
        .sort()
    );

    /** The format and the length in seconds of a 16 bit WAV file's samples, and whether any of them is not silence. */
    const wav = (bytes: Uint8Array) => {
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const tag = (offset: number) =>
        String.fromCharCode(...bytes.subarray(offset, offset + 4));
      let at = 12;
      while (tag(at) !== "data") {
        at += 8 + v.getUint32(at + 4, true);
      }
      const size = v.getUint32(at + 4, true);
      const channels = v.getUint16(22, true);
      const loud = bytes.subarray(at + 8, at + 8 + size).some((b) => b !== 0);
      return {
        loud,
        riff: `${tag(0)}${tag(8)}`,
        sampleRate: v.getUint32(24, true),
        seconds:
          size /
          (channels * (v.getUint16(34, true) / 8)) /
          v.getUint32(24, true),
      };
    };
    for (const id of sfxIds) {
      const entry = manifest.sfx[id] as (typeof manifest.sfx)[string];
      expect(entry.file).toBe(`${id}.wav`);
      const bytes = entries.get(`${dir}/${entry.file}`) as Uint8Array;
      const w = wav(bytes);
      expect(w.riff).toBe("RIFFWAVE");
      expect(w.sampleRate).toBe(project().project.sampleRate);
      expect(w.loud).toBe(true);
      expect(w.seconds).toBeCloseTo(entry.duration, 2);
      expect(entry.data).toEqual(sfxValue(id));
    }
    for (const [id, entry] of Object.entries(manifest.songs)) {
      const w = wav(entries.get(`${dir}/${entry.file}`) as Uint8Array);
      expect(w.loud).toBe(true);
      expect(w.seconds).toBeCloseTo(entry.duration, 2);
      const events = JSON.parse(
        new TextDecoder().decode(entries.get(`${dir}/${entry.events}`))
      ) as unknown[];
      expect(events.length, `events of ${id}`).toBeGreaterThan(0);
    }
    const ts = new TextDecoder().decode(entries.get("src/audio.ts"));
    expect(ts).toContain("export const manifest");
    expect(ts).toContain(`"${sfxIds[0]}": "${sfxIds[0]}.wav"`);
    // what is listed on the page is what is in the zip
    const listed = [...document.querySelectorAll("#pOut .files li span")].map(
      (el) => el.textContent
    );
    expect(listed.sort()).toEqual([...entries.keys()].sort());

    // the stale list now has nothing in it, until a sound is edited after the export
    expect(
      await until(
        () =>
          document.querySelector(".stale-h b")?.textContent ===
          "Everything is up to date",
        4000
      )
    ).toBe(true);
    const doc = project().get("sfx", sfxIds[0] as string) as never;
    const original = clone(sfxValue(sfxIds[0] as string));
    project().edit<Sfx>(doc, (d) => {
      d.volume = Math.min(1, d.volume / 2);
    });
    expect(
      await until(
        () =>
          stale().some(
            ([id, why]) =>
              id === sfxIds[0] && why === "changed since the last export"
          ),
        4000
      )
    ).toBe(true);
    project().edit<Sfx>(doc, () => clone(original));
  }, 150_000);

  it("shows an export that failed, and the button can be used again", async () => {
    await goProject();
    const { click: anchor } = HTMLAnchorElement.prototype;
    HTMLAnchorElement.prototype.click = () => {
      throw new Error("download blocked");
    };
    try {
      press(document.getElementById("pGo"));
      expect(
        await until(() => document.querySelector("#pOut .bad") !== null, 90_000)
      ).toBe(true);
      expect(document.querySelector("#pOut .bad")?.textContent).toBe(
        "Export failed: download blocked"
      );
      expect(
        (document.getElementById("pGo") as HTMLButtonElement).disabled
      ).toBe(false);
    } finally {
      HTMLAnchorElement.prototype.click = anchor;
    }
  }, 150_000);

  it("the project zip carries every document as saved, edits that were still waiting to save included", async () => {
    await goProject();
    const doc = project().get("sfx", "coin") as never;
    const original = clone(sfxValue("coin"));
    project().edit<Sfx>(doc, (d) => {
      d.volume = 0.123;
    });
    const downloads = await downloading(() => {
      press(document.getElementById("pZipOut"));
    });
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.name).toMatch(/-project\.zip$/);
    const { readZip } = await import("../src/zip.ts");
    const entries = new Map(
      (await readZip(downloads[0]?.bytes as Uint8Array)).map((e) => [
        e.path,
        e.data,
      ])
    );
    const json = (path: string) =>
      JSON.parse(new TextDecoder().decode(entries.get(path))) as never;
    expect(entries.has("project.json")).toBe(true);
    // the zip is the store's files: it is what is on disk, not the filled-out copies the project edits
    const onDisk = await Promise.all(
      [...project().docs.values()].map(async (d) => [
        d.path,
        await stored(d.path),
      ])
    );
    for (const [path, content] of onDisk) {
      expect(json(path as string), path as string).toEqual(content);
    }
    expect((json("sfx/coin.json") as Sfx).volume).toBe(0.123);
    project().edit<Sfx>(doc, () => clone(original));
  });

  it("imports documents from a zip and from dropped files, and says when a file is nothing it knows", async () => {
    const { writeZip } = await import("../src/zip.ts");
    await goProject();
    const files = (list: File[]) => {
      const input = document.getElementById("pZipIn") as HTMLInputElement;
      Object.defineProperty(input, "files", {
        configurable: true,
        value: list,
      });
      fire(input, "change");
    };
    const doc = { envelope: {}, frequency: {} };
    const zip = writeZip([
      {
        data: new TextEncoder().encode(JSON.stringify(doc)),
        path: "sfx/zipped.json",
      },
    ]);
    files([
      new File([zip as BlobPart], "extra.zip"),
      new File([JSON.stringify(doc)], "dropped.json"),
    ]);
    expect(await until(() => toast() === "Imported 2 files", 5000)).toBe(true);
    const kept = await Promise.all(
      ["zipped", "dropped"].map((id) => stored(`sfx/${id}.json`))
    );
    expect(kept).toEqual([doc, doc]);
    for (const id of ["zipped", "dropped"]) {
      // the file is kept as it came, and the project reads it in filled out like any other sound
      expect(sfxValue(id)).toMatchObject({
        category: expect.any(String),
        volume: expect.any(Number),
      });
    }
    const count = project().list("sfx").length;
    files([new File(["not json"], "bad.json")]);
    expect(
      await until(
        () =>
          toast() === "Nothing in that file looked like a Bleepkit document",
        5000
      )
    ).toBe(true);
    expect(project().list("sfx")).toHaveLength(count);
  });

  it("starting over asks first, keeps everything when declined, and brings back the starter kit when confirmed", async () => {
    const { starterFiles } = await import("../src/store/seed.ts");
    const starterSfx = [...starterFiles().keys()]
      .filter((p) => p.startsWith("sfx/"))
      .map((p) => p.replace(/^sfx\/|\.json$/g, ""))
      .sort();
    await goProject();
    const before = project()
      .list("sfx")
      .map((d) => d.id)
      .sort();
    expect(before).not.toEqual(starterSfx);
    press(document.getElementById("pReset"));
    press(document.querySelector(".confirm-btns .btn:not(.primary)"));
    await settle(60);
    expect(
      project()
        .list("sfx")
        .map((d) => d.id)
        .sort()
    ).toEqual(before);
    expect(location.hash).toContain("#/project");
    press(document.getElementById("pReset"));
    press(document.querySelector(".confirm-btns .btn.primary"));
    expect(await until(() => location.hash.startsWith("#/pads"), 8000)).toBe(
      true
    );
    expect(
      project()
        .list("sfx")
        .map((d) => d.id)
        .sort()
    ).toEqual(starterSfx);
    expect(project().get("sfx", "zipped")).toBeUndefined();
    await expect(project().store.readJson("sfx/zipped.json")).rejects.toThrow();
    expect(toast()).toBe("Back to the starter kit");
  });
});
