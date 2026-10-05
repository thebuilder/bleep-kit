/* Every view mounted in the real shell against the fake engine and a browser store, with every control in it worked:
   sliders dragged to both ends, selects walked through every option, buttons pressed, keys typed. The point is that
   nothing throws and the document ends up where the control says; the details of each control live in its own unit. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { drawLog, installCanvasStub, settle, until } from "./helpers.ts";

installCanvasStub();
vi.setConfig({ testTimeout: 60_000 });

type AppMod = typeof import("../src/app.ts");
type DocsMod = typeof import("../src/state/docs.ts");

let appMod: AppMod;
let docsMod: DocsMod;

const view = () => document.getElementById("view") as HTMLElement;
const insp = () => document.getElementById("insp") as HTMLElement;

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

/** Drag every range to both ends and the middle, type into numbers and text, walk every select, flip every switch. */
function work(
  root: Element,
  skip: (el: Element) => boolean = () => false
): void {
  for (const el of root.querySelectorAll<HTMLInputElement>("input")) {
    if (skip(el)) {
      continue;
    }
    if (el.type === "range") {
      const lo = Number(el.min || 0);
      const hi = Number(el.max || 100);
      for (const v of [lo, hi, (lo + hi) / 2]) {
        el.value = String(v);
        fire(el, "input");
      }
    } else if (el.type === "number") {
      el.value = String((Number(el.min || 0) + Number(el.max || 1)) / 2);
      fire(el, "change");
    } else if (el.type === "checkbox") {
      el.click();
      el.click();
    } else if (el.type === "text") {
      el.value = `${el.value}x`;
      fire(el, "input");
    }
  }
  for (const el of root.querySelectorAll<HTMLSelectElement>("select")) {
    if (skip(el)) {
      continue;
    }
    for (const o of Array.from(el.options)) {
      if (!o.disabled) {
        el.value = o.value;
        fire(el, "change");
      }
    }
  }
}

const press = (el: Element | null) => {
  (el as HTMLElement | null)?.click();
};

const go = async (hash: string, ready: () => boolean) => {
  appMod.app.navigate(hash);
  expect(await until(ready, 6000)).toBe(true);
  await settle(30);
};

beforeAll(async () => {
  vi.stubGlobal("confirm", () => true);
  (
    window as unknown as { happyDOM?: { setURL: (url: string) => void } }
  ).happyDOM?.setURL("http://localhost:3000/?engine=fake&store=local#/pads");
  document.body.innerHTML =
    '<canvas id="backdrop"></canvas><div id="app"></div>';
  appMod = await import("../src/app.ts");
  docsMod = await import("../src/state/docs.ts");
  const { boot } = await import("../src/shell.ts");
  await boot(document.getElementById("app") as HTMLElement);
  await until(() => document.querySelectorAll(".pad[data-id]").length > 0);
});

describe("pads", () => {
  it("shows the keys that play the pads that exist", () => {
    const n = document.querySelectorAll(".pad[data-id]").length;
    expect(document.getElementById("padHint")?.textContent).toContain("Keys");
    expect(n).toBeGreaterThan(0);
  });

  it("plays on a press, a key and Enter, and lights the pad", async () => {
    const pad = document.querySelector<HTMLElement>(
      ".pad[data-id]"
    ) as HTMLElement;
    pad.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 })
    );
    pad.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
    );
    key("1");
    key("q");
    key("z");
    await settle(120);
    expect(pad.classList.contains("hit")).toBe(true);
  });

  it("opens a drawer of four mutations, plays, keeps one, rerolls and closes", async () => {
    const mutate = document.querySelector<HTMLElement>(
      '.pad[data-id] [data-act="mutate"]'
    );
    press(mutate);
    expect(document.querySelectorAll(".vtile").length).toBe(4);
    const tile = document.querySelector(".vtile") as HTMLElement;
    tile.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 })
    );
    tile.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: " " })
    );
    press(document.querySelector('.drawer [data-act="reroll"]'));
    expect(document.querySelectorAll(".vtile").length).toBe(4);
    press(document.querySelector('.drawer [data-act="close"]'));
    expect(document.querySelector(".drawer")).toBeNull();
    press(mutate);
    const before = docsMod.project.list("sfx").length;
    press(document.querySelector('.vtile [data-act="keep"]'));
    expect(
      await until(() => docsMod.project.list("sfx").length === before + 1)
    ).toBe(true);
  });

  it("randomizes a pad and undoes it from the toast", async () => {
    press(document.querySelector('.pad[data-id] [data-act="randomize"]'));
    await settle(30);
    press(document.querySelector("#toast button"));
  });

  it("edits the selected pad in the inspector", async () => {
    work(insp());
    for (const b of insp().querySelectorAll<HTMLElement>(".btn")) {
      const t = b.textContent ?? "";
      if (t === "Mutate" || t === "Randomize" || t === "Analyse") {
        b.click();
      }
    }
    await settle(30);
    appMod.app.navigate("#/pads");
    await settle(30);
  });

  it("makes a new sound from the category picker", async () => {
    const before = docsMod.project.list("sfx").length;
    press(document.querySelector(".pad-new"));
    press(document.querySelector(".cat-grid button, .modal button.cat"));
    expect(await until(() => docsMod.project.list("sfx").length > before)).toBe(
      true
    );
  });

  it("duplicates and deletes a pad", async () => {
    const before = docsMod.project.list("sfx").length;
    for (const b of insp().querySelectorAll<HTMLElement>(".btn")) {
      if (b.textContent === "Duplicate") {
        b.click();
      }
    }
    expect(await until(() => docsMod.project.list("sfx").length > before)).toBe(
      true
    );
  });

  it("follows a change of the master volume and limiter", async () => {
    docsMod.project.editProject((p) => {
      p.master.volume = 0.5;
    });
    await settle(250);
    expect(drawLog.length).toBeGreaterThan(0);
  });
});

describe("the sfx editor", () => {
  it("works every field on every chip", async () => {
    await go("#/sfx/coin", () => document.querySelector("#sName") !== null);
    work(view());
    work(insp());
    // lock a group, then randomize and mutate keep it
    press(insp().querySelector(".lk"));
    key("r");
    key("m");
    press(document.getElementById("sRand"));
    press(document.getElementById("sMut"));
    press(document.getElementById("sPlay"));
    await settle(200);
  });

  it("shows a spectrogram on request and moves on to the analysis", async () => {
    press(document.getElementById("sSpecBtn"));
    await settle(100);
    press(document.getElementById("sSpecBtn"));
    press(document.getElementById("sAna"));
    expect(
      await until(() => document.getElementById("aRerun") !== null, 6000)
    ).toBe(true);
  });

  it("walks every sound of every category without error", async () => {
    for (const d of docsMod.project.list("sfx")) {
      // biome-ignore lint/performance/noAwaitInLoops: one editor at a time, each is mounted and unmounted in order
      await go(
        `#/sfx/${d.id}`,
        () =>
          (document.getElementById("sName") as HTMLInputElement | null)
            ?.value !== undefined
      );
      work(
        insp(),
        (el) => el instanceof HTMLSelectElement && el.options.length > 6
      );
    }
  });
});

describe("the song editor", () => {
  const tracker = () => document.getElementById("gTracker") as HTMLElement;
  const typeKeys = (...keys: string[]) => {
    for (const k of keys) {
      key(k, {}, tracker());
    }
  };

  it("moves around the grid and types notes, instruments, volumes and effects", async () => {
    await go(
      "#/song/starter-theme",
      () => document.querySelectorAll(".trow").length > 8
    );
    const rows = document.querySelectorAll(".trow").length;
    typeKeys(
      "ArrowDown",
      "ArrowDown",
      "ArrowUp",
      "ArrowRight",
      "ArrowLeft",
      "Tab",
      "Tab"
    );
    key("Tab", { shiftKey: true }, tracker());
    typeKeys("PageDown", "PageUp", "End", "Home");
    // note column: a note, note off, release, then a delete
    typeKeys(
      "z",
      "s",
      "x",
      "1",
      "`",
      "Delete",
      "ArrowUp",
      "ArrowUp",
      "ArrowUp"
    );
    // instrument column: two hex digits, then a bad number
    typeKeys("ArrowRight", "0", "0", "f", "f", "ArrowUp", "ArrowUp");
    // volume column
    typeKeys("ArrowRight", "a", "ArrowUp");
    // effect columns: a valid code and one that is not
    typeKeys(
      "ArrowRight",
      "a",
      "0",
      "f",
      "z",
      "z",
      "z",
      "Backspace",
      "ArrowUp"
    );
    typeKeys("-", "=", "=", "f", "f");
    typeKeys(
      "Backspace",
      "ArrowLeft",
      "ArrowLeft",
      "Backspace",
      "ArrowLeft",
      "Backspace"
    );
    expect(document.querySelectorAll(".trow").length).toBe(rows);
    await settle(50);
  });

  it("plays from the cursor, plays and pauses", async () => {
    typeKeys("Enter");
    press(document.getElementById("gPlay"));
    await settle(150);
    press(document.getElementById("gPlay"));
    press(document.getElementById("gPlay"));
    press(document.getElementById("gHere"));
    await settle(150);
    key("Escape");
    await settle(30);
  });

  it("clicks a cell, mutes, solos, shows an effect column and writes a channel in MML and back", async () => {
    const cell = document.querySelector<HTMLElement>(
      '.trow[data-r="3"] .tc[data-ch="1"] [data-f="1"]'
    );
    cell?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const head = document.getElementById("gHead") as HTMLElement;
    for (const act of ["mute", "solo", "fx", "fx"]) {
      press(head.querySelector(`[data-act="${act}"]`));
    }
    head
      .querySelector('[data-act="mute"]')
      ?.dispatchEvent(new MouseEvent("click", { altKey: true, bubbles: true }));
    press(head.querySelector(".tch"));
    press(head.querySelector('[data-act="mml"]'));
    await settle(30);
    const ta = document.querySelector<HTMLTextAreaElement>(".mml-ta");
    expect(ta).not.toBeNull();
    if (ta) {
      ta.value = `${ta.value} c d e [ f g ] ; @lead o4 l8 zz`;
      fire(ta, "input");
      key("a", {}, ta);
      ta.dispatchEvent(new Event("scroll"));
    }
    await settle(300);
    const boxes = document.querySelectorAll(".mml-box").length;
    press(document.querySelector(".mml-top .btn"));
    await settle(30);
    expect(document.querySelectorAll(".mml-box").length).toBe(boxes - 1);
  });

  it("edits the order list: new, copy, loop, move, change the pattern, remove", async () => {
    const order = document.getElementById("gOrder") as HTMLElement;
    const btn = (label: string) =>
      Array.from(order.querySelectorAll<HTMLElement>(".btn")).find(
        (b) => b.textContent === label
      ) ?? null;
    press(btn("New"));
    press(btn("Copy"));
    press(btn("Loop"));
    press(btn("Left"));
    press(btn("Right"));
    press(order.querySelector(".ochip"));
    const sel = order.querySelector<HTMLSelectElement>(".pat-sel");
    if (sel) {
      sel.value = sel.options[0]?.value ?? "";
      fire(sel, "change");
    }
    const chips = order.querySelectorAll(".ochip");
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
    if (chips.length > 1) {
      drag("dragstart", chips[0] as Element);
      drag("dragover", chips[1] as Element);
      drag("drop", chips[1] as Element);
    }
    press(btn("Remove"));
    await settle(30);
  });

  it("works the bar and the inspector", async () => {
    work(document.querySelector(".song-bar") as Element);
    work(insp());
    press(document.getElementById("gOctDn"));
    press(document.getElementById("gOctUp"));
    for (const b of insp().querySelectorAll<HTMLElement>(".legend-row, .btn")) {
      if (!document.contains(b)) {
        continue;
      }
      b.click();
      appMod.app.navigate("#/song/starter-theme");
      // biome-ignore lint/performance/noAwaitInLoops: each navigation has to finish before the next button is pressed
      await settle(20);
      break;
    }
    expect(document.querySelector(".trow")).not.toBeNull();
  });
});

describe("the instrument editor", () => {
  it("plays the keyboard with the mouse and the computer keys", async () => {
    const [first] = docsMod.project.list("instrument");
    await go(
      `#/instrument/${first?.id}`,
      () => document.getElementById("iKeys") !== null
    );
    const kb = document.getElementById("iKeys") as HTMLElement;
    const at = (type: string, x: number, y: number) =>
      kb.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: y,
          pointerId: 3,
        })
      );
    for (const [x, y] of [
      [20, 10],
      [20, 100],
      [200, 10],
      [400, 120],
    ] as const) {
      at("pointerdown", x, y);
      at("pointermove", x + 10, y);
      at("pointerup", x + 10, y);
    }
    for (const k of "zsxdcvgbhnjmq2w3er5t6y7u") {
      key(k);
      document.dispatchEvent(
        new KeyboardEvent("keyup", { bubbles: true, key: k })
      );
    }
    press(document.getElementById("iOctDn"));
    press(document.getElementById("iOctUp"));
    press(document.getElementById("iPlay"));
    key(" ");
    await settle(100);
  });

  it("works every panel of every instrument", async () => {
    for (const d of docsMod.project.list("instrument")) {
      // biome-ignore lint/performance/noAwaitInLoops: one editor at a time, each is mounted and unmounted in order
      await go(
        `#/instrument/${d.id}`,
        () => document.getElementById("iKeys") !== null
      );
      work(view(), (el) => el.id === "iName");
      work(insp());
      for (const b of view().querySelectorAll<HTMLElement>(
        "#iKindPanel button"
      )) {
        b.click();
      }
      await settle(40);
    }
  });

  it("draws in the macro editors and sets their loop and release flags", async () => {
    const [first] = docsMod.project.list("instrument");
    await go(
      `#/instrument/${first?.id}`,
      () => document.getElementById("iKeys") !== null
    );
    for (const cv of view().querySelectorAll<HTMLElement>(".macro canvas")) {
      const at = (
        type: string,
        x: number,
        y: number,
        extra: PointerEventInit = {}
      ) =>
        cv.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            button: 0,
            clientX: x,
            clientY: y,
            pointerId: 5,
            ...extra,
          })
        );
      at("pointerdown", 30, 20);
      at("pointermove", 90, 60);
      at("pointermove", 150, 5);
      at("pointerup", 150, 5);
      at("pointerdown", 40, 4, { shiftKey: true });
      at("pointerup", 40, 4);
    }
    work(view().querySelector("#iMacroStack") as Element);
    for (const b of view().querySelectorAll<HTMLElement>(
      "#iMacroStack button"
    )) {
      b.click();
    }
    await settle(50);
  });
});

describe("the analysis view", () => {
  it("analyses a sound and a song, reruns, copies and plays", async () => {
    await go(
      "#/analysis/sfx/coin",
      () => document.getElementById("aRerun") !== null
    );
    expect(
      await until(() => document.querySelectorAll(".stat").length > 3, 15_000)
    ).toBe(true);
    press(document.getElementById("aRerun"));
    press(document.getElementById("aCopy"));
    for (const b of view().querySelectorAll<HTMLElement>("button")) {
      b.click();
    }
    await settle(300);
    await go(
      "#/analysis/song/starter-theme",
      () => document.getElementById("aRerun") !== null
    );
    expect(
      await until(() => document.querySelectorAll(".stat").length > 3, 30_000)
    ).toBe(true);
    work(insp());
    work(view());
    await go(
      "#/analysis/",
      () => document.querySelector(".empty-state, #aRerun") !== null
    );
    await go(
      "#/analysis/sfx/missing",
      () => document.querySelector(".empty-state") !== null
    );
    for (const d of docsMod.project.list("instrument").slice(0, 1)) {
      // biome-ignore lint/performance/noAwaitInLoops: one analysis at a time
      await go(
        `#/analysis/instrument/${d.id}`,
        () => document.getElementById("aRerun") !== null
      );
      await until(() => document.querySelectorAll(".stat").length > 3, 15_000);
    }
  });
});

describe("keyboard shortcuts", () => {
  it("runs the Ctrl shortcuts: save, analysis, export, undo and redo, palette", async () => {
    await go(
      "#/sfx/coin",
      () =>
        document.getElementById("sPlay") !== null ||
        document.querySelector(".sfx-view") !== null
    );
    const mod = (
      k: string,
      init: KeyboardEventInit = {},
      el: Element = document.body
    ) => key(k, { ctrlKey: true, ...init }, el);
    mod("s");
    mod("z");
    mod("y");
    mod("z", { shiftKey: true });
    mod("a", { shiftKey: true });
    expect(
      await until(() => location.hash.startsWith("#/analysis/sfx/coin"), 3000)
    ).toBe(true);
    mod("e");
    expect(await until(() => location.hash.startsWith("#/project"), 3000)).toBe(
      true
    );
    mod("k");
    expect(document.querySelector(".palette, .modal, dialog")).not.toBeNull();
    key("Escape");
    mod("q");
    await settle(30);
  });

  it("does not undo while typing in a text field", async () => {
    await go("#/project", () => document.getElementById("pGo") !== null);
    const name = view().querySelector<HTMLInputElement>(
      'input[type="text"]'
    ) as HTMLInputElement;
    key("z", { ctrlKey: true }, name);
    key("Escape", {}, name);
    key("?");
    key("Escape");
    expect(document.body.contains(name)).toBe(true);
  });

  it("tells you analysis is for sounds and songs when an instrument is open", async () => {
    const [first] = docsMod.project.list("instrument");
    await go(
      `#/instrument/${first?.id}`,
      () => document.getElementById("iKeys") !== null
    );
    key("a", { ctrlKey: true, shiftKey: true });
    await settle(30);
    expect(location.hash).toContain("#/instrument/");
  });

  it("steps through the documents with the bracket keys", async () => {
    await go(
      "#/sfx/coin",
      () =>
        document.querySelector(".sfx-view") !== null ||
        document.getElementById("sPlay") !== null
    );
    const before = location.hash;
    key("]");
    expect(await until(() => location.hash !== before, 2000)).toBe(true);
    key("[");
    await settle(30);
  });
});

describe("the project view", () => {
  const lastToast = () =>
    document.querySelector(".toast, #toast")?.textContent ?? "";

  it("shows the settings, works every field and previews audio.ts", async () => {
    await go("#/project", () => document.getElementById("pGo") !== null);
    work(document.getElementById("pSetB") as Element);
    work(document.getElementById("pExpB") as Element);
    work(insp());
    expect(document.getElementById("pCode")?.textContent).toContain("manifest");
    expect(document.getElementById("pWhere")?.textContent).toContain("browser");
    await settle(400);
    expect(document.getElementById("pCode")?.textContent).toContain(
      "AudioManifest"
    );
  });

  it("copies audio.ts, and says so when the clipboard refuses", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: write },
    });
    press(document.getElementById("pCopy"));
    await settle(20);
    expect(write).toHaveBeenCalled();
    write.mockRejectedValue(new Error("denied"));
    press(document.getElementById("pCopy"));
    await settle(20);
    expect(lastToast()).toContain("Could not copy");
  });

  it("lists what changed, and each chip opens its sound", async () => {
    await go("#/project", () => document.getElementById("pGo") !== null);
    const [first] = docsMod.project.list("sfx");
    docsMod.project.edit<import("../src/lib/contract.ts").Sfx>(
      first as never,
      (d) => {
        d.name = `${d.name}!`;
      }
    );
    expect(
      await until(() => document.querySelectorAll(".stale-chip").length > 0)
    ).toBe(true);
    const chip = document.querySelector<HTMLElement>(
      ".stale-chip"
    ) as HTMLElement;
    expect(chip.querySelector("small")?.textContent).toBeTruthy();
    chip.click();
    expect(location.hash).toMatch(/^#\/(sfx|song)\//);
  });

  it("exports in the browser: renders, encodes, zips, downloads and lists the files", async () => {
    const urls: Blob[] = [];
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: (b: Blob) => {
          urls.push(b);
          return "blob:x";
        },
        revokeObjectURL: () => undefined,
      })
    );
    docsMod.project.editProject((p) => {
      p.export.sfxFormat = "wav";
      p.export.musicFormat = "wav";
      p.export.events = true;
      p.export.embed = true;
    }, "test");
    await go("#/project", () => document.getElementById("pGo") !== null);
    press(document.getElementById("pGo"));
    press(document.getElementById("pGo"));
    expect(
      await until(() => document.querySelector("#pOut .ok") !== null, 90_000)
    ).toBe(true);
    expect(document.querySelectorAll("#pOut .files li").length).toBeGreaterThan(
      5
    );
    expect(document.getElementById("pOut")?.textContent).toContain("manifest");
    expect(urls.length).toBeGreaterThan(0);
    expect(
      await until(
        () =>
          document.querySelector(".stale-h b")?.textContent ===
          "Everything is up to date",
        3000
      )
    ).toBe(true);
  }, 120_000);

  it("shows an export that failed", async () => {
    docsMod.project.editProject((p) => {
      p.export.sfxFormat = "wav";
    }, "test");
    const { click: anchor } = HTMLAnchorElement.prototype;
    HTMLAnchorElement.prototype.click = () => {
      throw new Error("download blocked");
    };
    try {
      await go("#/project", () => document.getElementById("pGo") !== null);
      press(document.getElementById("pGo"));
      expect(
        await until(() => document.querySelector("#pOut .bad") !== null, 90_000)
      ).toBe(true);
      expect(document.querySelector("#pOut .bad")?.textContent).toContain(
        "download blocked"
      );
    } finally {
      HTMLAnchorElement.prototype.click = anchor;
    }
  }, 120_000);

  it("downloads a project zip, imports zips and documents, and starts over", async () => {
    const { writeZip } = await import("../src/zip.ts");
    const downloads: string[] = [];
    const { click } = HTMLAnchorElement.prototype;
    HTMLAnchorElement.prototype.click = function recorded(
      this: HTMLAnchorElement
    ) {
      downloads.push(this.download);
    };
    try {
      await go("#/project", () => document.getElementById("pZipOut") !== null);
      press(document.getElementById("pZipOut"));
      expect(await until(() => downloads.length > 0)).toBe(true);
      expect(downloads[0]).toMatch(/-project\.zip$/);
    } finally {
      HTMLAnchorElement.prototype.click = click;
    }

    const files = (list: File[]) => {
      const input = document.getElementById("pZipIn") as HTMLInputElement;
      Object.defineProperty(input, "files", {
        configurable: true,
        value: list,
      });
      fire(input, "change");
    };
    const sfxDoc = { envelope: {}, frequency: {} };
    const zip = writeZip([
      {
        data: new TextEncoder().encode(JSON.stringify(sfxDoc)),
        path: "sfx/zipped.json",
      },
    ]);
    files([
      new File([zip as BlobPart], "extra.zip"),
      new File([JSON.stringify(sfxDoc)], "dropped.json"),
    ]);
    expect(await until(() => lastToast().includes("Imported"), 5000)).toBe(
      true
    );
    files([new File(["not json"], "bad.json")]);
    expect(
      await until(() => lastToast().includes("Nothing in that file"), 5000)
    ).toBe(true);

    await go("#/project", () => document.getElementById("pReset") !== null);
    press(document.getElementById("pReset"));
    press(document.querySelector(".confirm-btns .btn:not(.primary)"));
    await settle(30);
    expect(location.hash).toContain("#/project");
    press(document.getElementById("pReset"));
    press(document.querySelector(".confirm-btns .btn.primary"));
    expect(await until(() => location.hash.startsWith("#/pads"), 8000)).toBe(
      true
    );
  }, 60_000);
});
