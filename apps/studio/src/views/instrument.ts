/* The instrument editor: a playable two octave keyboard (mouse, touch and computer keys), the five macro bar editors with
   loop and release flags, and the panel for the instrument's kind: pulse duty icons, a wavetable grid, the SID panel,
   FM algorithm diagrams with operator strips, or the sample generator. The inspector holds the shared fields. */
import type { Command, ViewHooks } from "../app.ts";
import { app } from "../app.ts";
import { engine } from "../engine/engine.ts";
import { CHIP_THEME, KIND_HEX, KIND_LABEL } from "../lib/chips.ts";
import {
  CHANNEL_KINDS,
  CHIP_IDS,
  type ChannelKind,
  type ChipId,
  type EngineEvent,
  type Instrument,
  type Macro,
  type SampleGeneratorSpec,
} from "../lib/contract.ts";
import {
  chipProfile,
  defaultInstrument,
  generateSample,
  noteName,
  SAMPLE_GENERATORS,
} from "../lib/core.ts";
import { choose, clamp, debounce, fire, h, prefs } from "../lib/dom.ts";
import { fitFmOps, toggleSidWave } from "../lib/instrument-edits.ts";
import { playInstrumentDoc, releaseNote, stopEverything } from "../playback.ts";
import type { ViewCtx } from "../shell.ts";
import { type Doc, project } from "../state/docs.ts";
import { deleteButton } from "../ui/delete-doc.ts";
import {
  type FieldHandle,
  group,
  note,
  rangeField,
  selectField,
  textField,
  toggleField,
} from "../ui/fields.ts";
import { dutySvg } from "../ui/fm.ts";
import { buildFmPanel } from "../ui/fm-panel.ts";
import { icon } from "../ui/icons.ts";
import { showIssues } from "../ui/issues.ts";
import {
  type MacroEditor,
  type MacroSpec,
  macroEditor,
  macroTick,
} from "../ui/macro.ts";
import {
  createPiano,
  keyToOffset,
  LOWER_KEYS,
  UPPER_KEYS,
} from "../ui/piano.ts";
import { presetTable, waveGrid } from "../ui/wavegrid.ts";
import { addVisual, type Frame } from "../visuals/loop.ts";

/** The sample generator spec for an id that may not be a known generator (a hand edited document). */
function generatorSpec(id: string): SampleGeneratorSpec | undefined {
  return (SAMPLE_GENERATORS as Readonly<Record<string, SampleGeneratorSpec>>)[
    id
  ];
}

/** How a macro's values are printed by scale (the others show the plain number). */
const MACRO_FORMAT: Partial<Record<string, { format: (v: number) => string }>> =
  {
    cents: { format: (v) => `${v} cents` },
    semi: { format: (v) => `${v > 0 ? "+" : ""}${v} st` },
    unit: { format: (v) => `${Math.round(v * 15)}/15` },
  };

const DUTY_DEFAULT = [0.125, 0.25, 0.5, 0.75];
const SID_WAVES = ["tri", "saw", "pulse", "noise"] as const;

type MacroKey = "volume" | "arpeggio" | "pitch" | "duty" | "pan";

export function mountInstrument(ctx: ViewCtx, id: string): ViewHooks {
  const { host, insp } = ctx;
  const doc = (): Doc<Instrument> =>
    project.get<Instrument>("instrument", id) as Doc<Instrument>;
  const inst = () => doc().value;
  const hex = () => KIND_HEX[inst().kind];
  let octave = prefs.get("kb-octave", 3);
  let testNote = prefs.get("inst-test-note", 60);
  let testDur = prefs.get("inst-test-dur", 0.6);
  let playOnChange = prefs.get("inst-play-change", true);
  const macros = new Map<
    MacroKey,
    { ed: MacroEditor; get: () => Macro | undefined }
  >();
  const heldKeys = new Map<string, number>();
  const chanNote = new Map<number, number>();
  const wasHeld = {
    note: -1,
    released: null as number | null,
    since: 0,
    until: 0,
  };

  host.innerHTML = `
    <div class="ed inst-ed">
      <div class="ed-head">
        <div class="ed-title">
          <span class="big-ico" id="iIcon"></span>
          <input class="nm-in" id="iName" aria-label="Instrument name" maxlength="60" spellcheck="false">
        </div>
        <div class="ed-sel"><span class="kind-badge" id="iKind"></span></div>
        <div class="ed-actions test-row">
          <label class="sel"><span>Test note</span><select id="iNote" aria-label="Test note"></select></label>
          <label class="sel num"><span>Seconds</span><input type="number" id="iDur" min="0.1" max="8" step="0.1" aria-label="Test note length"></label>
          <button class="btn primary big" id="iPlay" title="Play the test note (Space)">${icon("play", 16)}<span>Play</span></button>
          <label class="tgl-row" title="Play the test note after each change"><span class="tgl"><input type="checkbox" id="iAuto"><span></span></span><small>Play on every change</small></label>
        </div>
      </div>
      <div class="kb-wrap">
        <div class="kb-head"><span class="pxh">Keyboard</span><span class="hint2">Play with the mouse, or the keys Z S X D C V G B H N J M and Q 2 W 3 E R 5 T 6 Y 7 U</span>
          <span class="oct"><button class="btn icon small" id="iOctDn" aria-label="Octave down">${icon("minus", 12)}</button><b class="mono" id="iOct"></b><button class="btn icon small" id="iOctUp" aria-label="Octave up">${icon("plus", 12)}</button></span></div>
        <canvas class="kb" id="iKeys" aria-label="Piano keyboard"></canvas>
      </div>
      <div class="issue-slot" id="iIssues"></div>
      <section class="card" id="iKindPanel"></section>
      <section class="card" id="iMacros"><div class="card-h"><h3 class="pxh">Macros</h3><span class="muted">One value per tick (60 per second). Drag across the bars to draw. Flags mark where the sequence loops and where it jumps on release.</span></div><div class="macro-stack" id="iMacroStack"></div></section>
    </div>`;
  const q = <T extends HTMLElement>(sel: string) =>
    host.querySelector(sel) as T;
  const nameIn = q<HTMLInputElement>("#iName");
  const noteSel = q<HTMLSelectElement>("#iNote");
  const durIn = q<HTMLInputElement>("#iDur");
  const autoIn = q<HTMLInputElement>("#iAuto");
  const octEl = q("#iOct");
  const kindPanel = q("#iKindPanel");
  const macroStack = q("#iMacroStack");
  for (let n = 36; n <= 96; n += 1) {
    noteSel.append(h("option", { value: n }, noteName(n)));
  }
  noteSel.value = String(testNote);
  durIn.value = String(testDur);
  autoIn.checked = playOnChange;

  /* ----- keyboard ----- */
  const labels = new Map<number, string>();
  const relabel = () => {
    labels.clear();
    const lo = (octave + 1) * 12;
    for (const [i, c] of (LOWER_KEYS + UPPER_KEYS).split("").entries()) {
      labels.set(lo + i, c.toUpperCase());
    }
  };
  relabel();
  const kbCanvas = q<HTMLCanvasElement>("#iKeys");
  let piano = makePiano();
  function makePiano() {
    const lo = (octave + 1) * 12;
    return createPiano(kbCanvas, {
      hi: lo + 23,
      label: (n) => labels.get(n) ?? null,
      lo,
      onDown: (n) => noteDown(n),
      onUp: (n) => noteUp(n),
    });
  }
  function setOctave(o: number): void {
    octave = clamp(o, 1, 6);
    prefs.set("kb-octave", octave);
    octEl.textContent = String(octave);
    piano.dispose();
    relabel();
    piano = makePiano();
    piano.draw();
  }
  octEl.textContent = String(octave);

  function noteDown(n: number): void {
    const d = doc();
    const ch = engine.previewNoteOn(d.id, d.value, n);
    chanNote.set(ch, n);
    engine.announce({
      channel: ch,
      channelId: d.value.kind,
      hz: 440 * 2 ** ((n - 69) / 12),
      id: d.id,
      note: n,
      type: "noteOn",
      velocity: 0.9,
    });
    piano.light(n, hex(), true);
    wasHeld.note = n;
    wasHeld.since = performance.now();
    wasHeld.released = null;
    wasHeld.until = 0;
    fire(engine.unlock());
  }
  function noteUp(n: number): void {
    const ch = engine.previewChannelFor(inst().kind);
    if (chanNote.get(ch) === n) {
      engine.noteOff(ch);
      engine.announce({ channel: ch, channelId: inst().kind, type: "noteOff" });
      chanNote.delete(ch);
    }
    piano.release(n);
    if (wasHeld.note === n) {
      wasHeld.released = performance.now() - wasHeld.since;
      wasHeld.until = performance.now() + 700;
    }
  }
  const onKeyUp = (e: KeyboardEvent) => {
    const n = heldKeys.get(e.key.toLowerCase());
    if (n !== undefined) {
      heldKeys.delete(e.key.toLowerCase());
      noteUp(n);
    }
  };
  document.addEventListener("keyup", onKeyUp);

  /* ----- playing ----- */
  function play(): void {
    const d = doc();
    playInstrumentDoc(d, testNote, testDur);
    piano.light(
      clamp(testNote, (octave + 1) * 12, (octave + 1) * 12 + 23),
      hex(),
      true
    );
    setTimeout(
      () =>
        piano.release(
          clamp(testNote, (octave + 1) * 12, (octave + 1) * 12 + 23)
        ),
      testDur * 1000
    );
    wasHeld.note = testNote;
    wasHeld.since = performance.now();
    wasHeld.released = null;
    wasHeld.until = performance.now() + testDur * 1000 + 700;
    setTimeout(() => {
      wasHeld.released = testDur * 1000;
    }, testDur * 1000);
  }
  const autoPlay = debounce(() => {
    if (playOnChange) {
      play();
    }
  }, 160);

  /* ----- editing ----- */
  const edit = (fn: (d: Instrument) => void, key: string, auto = true) => {
    project.edit<Instrument>(doc(), fn, `inst:${key}`);
    if (auto) {
      autoPlay();
    }
  };

  const chipOf = (): ChipId => inst().chip ?? project.project.chip;
  const chipName = () => CHIP_THEME[chipOf()].short;

  /* ----- kind panels ----- */
  function card(
    title: string,
    sub?: string
  ): { el: HTMLElement; body: HTMLElement } {
    const body = h("div", { class: "card-b" });
    const head = h(
      "div",
      { class: "card-h" },
      h("h3", { class: "pxh" }, title)
    );
    if (sub) {
      head.append(h("span", { class: "muted" }, sub));
    }
    return { body, el: h("div", {}, head, body) };
  }

  function buildKindPanel(): void {
    kindPanel.replaceChildren();
    const i = inst();
    const k = i.kind;
    const c = card(`${KIND_LABEL[k]} patch`);
    kindPanel.append(c.el);
    switch (k) {
      case "pulse":
        buildPulse(c.body);
        break;
      case "wave":
        buildWave(c.body);
        break;
      case "noise":
        buildNoise(c.body);
        break;
      case "triangle":
        c.body.append(
          h(
            "p",
            { class: "muted" },
            "A triangle channel has no patch. Its envelope and the volume macro act as a gate: a level above 0.5 is on, anything lower is off, as on the NES."
          )
        );
        break;
      case "sid":
        buildSid(c.body);
        break;
      case "fm":
        buildFm(c.body);
        break;
      case "sample":
        buildSample(c.body);
        break;
      default:
        break;
    }
  }

  function buildPulse(body: HTMLElement): void {
    const list = (() => {
      const l = chipProfile(chipOf()).constraints.dutyCycles;
      return l.length ? [...l] : DUTY_DEFAULT;
    })();
    const free = chipProfile(chipOf()).constraints.dutyCycles.length === 0;
    const row = h("div", {
      "aria-label": "Pulse width",
      class: "duty-row",
      role: "radiogroup",
    });
    const nearest = () => {
      const d = inst().pulse?.duty ?? 0.5;
      return list.reduce(
        (best, v, idx) =>
          Math.abs(v - d) < Math.abs((list[best] ?? 0) - d) ? idx : best,
        0
      );
    };
    list.forEach((d, idx) => {
      const b = h("button", {
        "aria-checked": String(idx === nearest()),
        class: `duty${idx === nearest() ? " on" : ""}`,
        "data-i": idx,
        role: "radio",
        title: `${d * 100}% pulse width. The duty macro calls this index ${idx}.`,
      });
      b.innerHTML = `<span class="di">${dutySvg(d)}</span><b class="mono">${Math.round(d * 1000) / 10}%</b><small>index ${idx}</small>`;
      b.addEventListener("click", () => {
        edit((x) => {
          x.pulse = { duty: d };
        }, "duty");
        for (const el of row.querySelectorAll(".duty")) {
          const on = Number((el as HTMLElement).dataset.i) === idx;
          el.classList.toggle("on", on);
          el.setAttribute("aria-checked", String(on));
        }
        fine.set(d);
      });
      row.append(b);
    });
    body.append(row);
    const fb = h("div", { class: "fields" });
    body.append(fb);
    const fine = rangeField(fb, {
      label: "Pulse width",
      max: 0.95,
      min: 0.05,
      off: free
        ? false
        : `${chipName()} only has ${list.map((d) => `${d * 100}%`).join(", ")}`,
      onInput: (v) =>
        edit((x) => {
          x.pulse = { duty: v };
        }, "duty"),
      step: 0.005,
      value: inst().pulse?.duty ?? 0.5,
    });
  }

  function buildWave(body: HTMLElement): void {
    const wg = waveGrid({
      color: hex(),
      onChange: (t) =>
        edit((x) => {
          x.wave = { table: t };
        }, "table"),
      table: inst().wave?.table ?? presetTable("sine"),
    });
    body.append(wg.el);
    const prof = chipProfile(chipOf()).constraints.waveTable;
    body.append(
      h(
        "p",
        { class: "muted" },
        prof
          ? `${CHIP_THEME[chipOf()].short} plays a ${prof.length} step table with ${prof.bits} bit values. Draw in the grid or pick a preset.`
          : "32 steps with values 0 to 15. Draw in the grid or pick a preset."
      )
    );
    wavePreview = wg;
  }
  let wavePreview: ReturnType<typeof waveGrid> | null = null;

  function buildNoise(body: HTMLElement): void {
    const fb = h("div", { class: "fields" });
    body.append(fb);
    selectField<"long" | "short">(fb, {
      label: "Noise mode",
      onInput: (v) =>
        edit((x) => {
          x.noise = { mode: v };
        }, "noise"),
      options: ["long", "short"],
      value: inst().noise?.mode ?? "long",
    });
    body.append(
      h(
        "p",
        { class: "muted" },
        "Long noise is a hiss. Short noise repeats quickly and sounds metallic and pitched, like the NES 'periodic' mode."
      )
    );
  }

  function buildSid(body: HTMLElement): void {
    const { sid } = inst();
    if (!sid) {
      return;
    }
    const row = h("div", {
      "aria-label": "SID waveforms",
      class: "chip-row",
      role: "group",
    });
    const handles: Record<string, FieldHandle | undefined> = {};
    const refresh = () => {
      const s = inst().sid;
      for (const b of row.querySelectorAll<HTMLElement>("button")) {
        const on = !!s?.waveforms.includes(
          b.dataset.w as (typeof SID_WAVES)[number]
        );
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
      }
      handles.pw?.setOff(
        s?.waveforms.includes("pulse")
          ? false
          : "Pulse width needs the pulse waveform"
      );
      handles.pwmRate?.setOff(
        s?.waveforms.includes("pulse") ? false : "PWM needs the pulse waveform"
      );
      handles.pwmDepth?.setOff(
        s?.waveforms.includes("pulse") ? false : "PWM needs the pulse waveform"
      );
      const mode = s?.filter.mode ?? "off";
      for (const k of ["cutoff", "res", "sweep"]) {
        handles[k]?.setOff(mode === "off" ? "Turn the filter on first" : false);
      }
    };
    for (const w of SID_WAVES) {
      const b = h(
        "button",
        {
          "aria-pressed": "false",
          class: "tog",
          "data-w": w,
          title: `Toggle the ${w} waveform. Several at once are combined like the real chip.`,
        },
        w
      );
      b.addEventListener("click", () => {
        edit((x) => toggleSidWave(x, w), "sidwave");
        refresh();
      });
      row.append(b);
    }
    body.append(row);
    const fb = h("div", { class: "fields two" });
    body.append(fb);
    const S = (
      key: string,
      label: string,
      get: (s: NonNullable<Instrument["sid"]>) => number,
      set: (s: NonNullable<Instrument["sid"]>, v: number) => void,
      min: number,
      max: number,
      step: number
    ) => {
      handles[key] = rangeField(fb, {
        label,
        max,
        min,
        onInput: (v) =>
          edit((x) => {
            if (x.sid) {
              set(x.sid, v);
            }
          }, `sid${key}`),
        step,
        value: get(sid),
      });
    };
    S(
      "pw",
      "Pulse width",
      (s) => s.pulseWidth,
      (s, v) => {
        s.pulseWidth = v;
      },
      0,
      1,
      0.005
    );
    S(
      "pwmRate",
      "PWM rate (Hz)",
      (s) => s.pwmRate,
      (s, v) => {
        s.pwmRate = v;
      },
      0,
      20,
      0.1
    );
    S(
      "pwmDepth",
      "PWM depth",
      (s) => s.pwmDepth,
      (s, v) => {
        s.pwmDepth = v;
      },
      0,
      1,
      0.01
    );
    toggleField(fb, {
      label: "Ring mod",
      onInput: (v) =>
        edit((x) => {
          if (x.sid) {
            x.sid.ring = v;
          }
        }, "sidring"),
      value: sid.ring,
    });
    toggleField(fb, {
      label: "Sync",
      onInput: (v) =>
        edit((x) => {
          if (x.sid) {
            x.sid.sync = v;
          }
        }, "sidsync"),
      value: sid.sync,
    });
    selectField<"off" | "lp" | "bp" | "hp">(fb, {
      label: "Filter",
      onInput: (v) => {
        edit((x) => {
          if (x.sid) {
            x.sid.filter.mode = v;
          }
        }, "sidfmode");
        refresh();
      },
      options: ["off", "lp", "bp", "hp"],
      value: sid.filter.mode,
    });
    S(
      "cutoff",
      "Cutoff",
      (s) => s.filter.cutoff,
      (s, v) => {
        s.filter.cutoff = v;
      },
      0,
      1,
      0.005
    );
    S(
      "res",
      "Resonance",
      (s) => s.filter.resonance,
      (s, v) => {
        s.filter.resonance = v;
      },
      0,
      1,
      0.01
    );
    S(
      "sweep",
      "Sweep per tick",
      (s) => s.filter.sweep,
      (s, v) => {
        s.filter.sweep = v;
      },
      -0.05,
      0.05,
      0.001
    );
    refresh();
  }

  function buildFm(body: HTMLElement): void {
    buildFmPanel(body, {
      edit,
      hex,
      inst,
      waveSelect: {
        chipName: chipName(),
        ok: chipProfile(chipOf()).fmWaveforms,
      },
    });
  }

  let sampleCanvas: HTMLCanvasElement | null = null;
  function drawSamplePreview(): void {
    const s = inst().sample;
    const cv = sampleCanvas;
    const g = cv?.getContext("2d");
    if (!(s && cv && g)) {
      return;
    }
    g.fillStyle = "#0e0d14";
    g.fillRect(0, 0, cv.width, cv.height);
    try {
      const out = generateSample(s.generator, s.params, s.seed, 22_050);
      const n = cv.width;
      const per = out.data.length / n;
      const mid = cv.height / 2;
      for (let x = 0; x < n; x += 1) {
        let lo = 0;
        let hi = 0;
        for (
          let i = Math.floor(x * per);
          i < Math.floor((x + 1) * per);
          i += 1
        ) {
          const v = out.data[i] ?? 0;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
        g.fillStyle = hex();
        const top = Math.round(mid - hi * (mid - 2));
        const bot = Math.round(mid - lo * (mid - 2));
        g.fillRect(x, top, 1, Math.max(1, bot - top));
      }
      if (out.loopStart !== null && out.loopEnd !== null && s.loop) {
        g.fillStyle = "#74c08f";
        g.fillRect(
          Math.floor((out.loopStart / out.data.length) * n),
          0,
          1,
          cv.height
        );
        g.fillStyle = "#b49ae6";
        g.fillRect(
          Math.floor((out.loopEnd / out.data.length) * n),
          0,
          1,
          cv.height
        );
      }
    } catch {
      g.fillStyle = "#e2766f";
      g.fillText("Could not generate this sample", 8, 16);
    }
  }

  function buildSample(body: HTMLElement): void {
    const s = inst().sample;
    if (!s) {
      return;
    }
    sampleCanvas = h("canvas", {
      "aria-label": "Generated sample",
      class: "sample-cv",
      height: 90,
      width: 480,
    });
    body.append(sampleCanvas);
    const fb = h("div", { class: "fields two" });
    body.append(fb);
    const paramBox = h("div", { class: "fields two span" });
    const buildParams = () => {
      paramBox.replaceChildren();
      const spec = generatorSpec(inst().sample?.generator ?? "");
      for (const [k, p] of Object.entries(spec?.params ?? {})) {
        rangeField(paramBox, {
          label: p.label,
          max: p.max,
          min: p.min,
          onInput: (v) => {
            edit((x) => {
              if (x.sample) {
                x.sample.params = { ...x.sample.params, [k]: v };
              }
            }, `sp${k}`);
            drawSamplePreview();
          },
          step: (p.max - p.min) / 100,
          value: inst().sample?.params[k] ?? p.default,
        });
      }
    };
    let loopField: (FieldHandle & { input: HTMLInputElement }) | null = null;
    selectField<string>(fb, {
      label: "Generator",
      onInput: (v) => {
        const spec = generatorSpec(v);
        edit((x) => {
          if (x.sample) {
            x.sample.generator = v as NonNullable<
              Instrument["sample"]
            >["generator"];
            x.sample.params = Object.fromEntries(
              Object.entries(spec?.params ?? {}).map(([k, p]) => [k, p.default])
            );
          }
        }, "sgen");
        loopField?.setOff(
          spec?.loops
            ? false
            : `The ${spec?.label ?? v} generator does not loop`
        );
        buildParams();
        drawSamplePreview();
      },
      options: Object.values(SAMPLE_GENERATORS).map((g) => ({
        label: g.label,
        value: g.id,
      })),
      value: s.generator,
    });
    rangeField(fb, {
      label: "Base note",
      max: 96,
      min: 24,
      onInput: (v) =>
        edit((x) => {
          if (x.sample) {
            x.sample.baseNote = Math.round(v);
          }
        }, "sbase"),
      step: 1,
      value: s.baseNote,
    });
    loopField = toggleField(fb, {
      label: "Loop",
      off: SAMPLE_GENERATORS[s.generator]?.loops
        ? false
        : `The ${SAMPLE_GENERATORS[s.generator]?.label ?? s.generator} generator does not loop`,
      onInput: (v) => {
        edit((x) => {
          if (x.sample) {
            x.sample.loop = v;
          }
        }, "sloop");
        drawSamplePreview();
      },
      value: s.loop,
    });
    const regen = h("button", {
      class: "btn",
      title: "Generate this sample again with a new seed",
    });
    regen.innerHTML = `${icon("dice", 14)}<span>Regenerate</span>`;
    const seedLabel = h("span", { class: "mono muted" }, `seed ${s.seed}`);
    regen.addEventListener("click", () => {
      const seed = Math.floor(Math.random() * 100_000);
      edit((x) => {
        if (x.sample) {
          x.sample.seed = seed;
        }
      }, "sseed");
      seedLabel.textContent = `seed ${seed}`;
      drawSamplePreview();
    });
    fb.append(h("div", { class: "fld" }, regen, seedLabel));
    body.append(paramBox);
    buildParams();
    drawSamplePreview();
  }

  /* ----- macros ----- */
  function buildMacros(): void {
    for (const m of macros.values()) {
      m.ed.dispose();
    }
    macros.clear();
    macroStack.replaceChildren();
    const i = inst();
    const prof = chipProfile(chipOf());
    const defs: {
      key: MacroKey;
      title: string;
      spec: MacroSpec;
      hint?: string;
      off?: string | false;
    }[] = [
      {
        hint:
          i.kind === "triangle"
            ? "On a triangle this is a gate: above 0.5 is on"
            : "A 0 to 1 multiplier on the envelope",
        key: "volume",
        spec: { scale: "unit" },
        title: "Volume",
      },
      {
        hint: "Semitone offsets, or absolute notes in fixed mode",
        key: "arpeggio",
        spec: { scale: "semi" },
        title: "Arpeggio",
      },
      {
        hint: "Cents added every tick (they accumulate)",
        key: "pitch",
        spec: { scale: "cents" },
        title: "Pitch",
      },
    ];
    if (i.kind === "pulse" || i.kind === "wave" || i.kind === "sid") {
      defs.push({
        hint: choose(
          [
            [i.kind === "pulse", "Index into the chip's duty list"],
            [i.kind === "wave", "Wave table index"],
          ],
          "Waveform mask"
        ),
        key: "duty",
        spec: {
          max: choose(
            [
              [
                i.kind === "pulse",
                Math.max(3, (prof.constraints.dutyCycles.length || 4) - 1),
              ],
              [i.kind === "wave", 7],
            ],
            15
          ),
          scale: "index",
        },
        title: choose(
          [
            [i.kind === "pulse", "Duty"],
            [i.kind === "wave", "Wave"],
          ],
          "Waveform"
        ),
      });
    }
    defs.push({
      key: "pan",
      off: prof.constraints.pan === "none" ? `${chipName()} has no pan` : false,
      spec: { scale: "pan" },
      title: "Pan",
    });
    for (const d of defs) {
      const ed = macroEditor({
        color: hex(),
        macro: inst().macros[d.key],
        off: d.off ?? false,
        spec: d.spec,
        title: d.title,
        ...(d.hint ? { hint: d.hint } : {}),
        onChange: (m) =>
          edit((x) => {
            if (m) {
              x.macros[d.key] = m as never;
            } else {
              delete x.macros[d.key];
            }
          }, `m-${d.key}`),
        ...MACRO_FORMAT[d.spec.scale],
      });
      if (d.key === "arpeggio") {
        const modeSel = h("select", {
          "aria-label": "Arpeggio mode",
          class: "preset",
          title:
            "Offset adds semitones to the played note; fixed plays absolute notes",
        }) as HTMLSelectElement;
        modeSel.append(
          h("option", { value: "offset" }, "Offset"),
          h("option", { value: "fixed" }, "Fixed notes")
        );
        modeSel.value = inst().macros.arpeggioMode ?? "offset";
        modeSel.addEventListener("change", () =>
          edit((x) => {
            x.macros.arpeggioMode = modeSel.value as "offset" | "fixed";
          }, "arpmode")
        );
        ed.el.querySelector(".macro-t")?.append(modeSel);
      }
      macros.set(d.key, { ed, get: () => inst().macros[d.key] });
      macroStack.append(ed.el);
    }
  }

  /* ----- inspector ----- */
  function buildInspector(): void {
    insp.replaceChildren();
    const i = inst();
    const inner = h("div", { class: "insp-in" });
    insp.append(inner);
    const g1 = group("Instrument", { key: "inst-main" });
    textField(g1.body, {
      label: "Name",
      onInput: (v) =>
        edit(
          (x) => {
            x.name = v;
          },
          "name",
          false
        ),
      value: i.name,
    });
    selectField<ChannelKind>(g1.body, {
      label: "Kind",
      onInput: changeKind,
      options: CHANNEL_KINDS.map((k) => ({ label: KIND_LABEL[k], value: k })),
      value: i.kind,
    });
    selectField<string>(g1.body, {
      label: "Chip",
      onInput: changeChip,
      options: [
        { label: "Any chip", value: "" },
        ...CHIP_IDS.map((c) => ({
          disabled: !chipProfile(c).kinds.includes(i.kind),
          label: chipProfile(c).kinds.includes(i.kind)
            ? CHIP_THEME[c].short
            : `${CHIP_THEME[c].short} (no ${i.kind})`,
          value: c,
        })),
      ],
      value: i.chip ?? "",
    });
    inner.append(g1.el);
    const g2 = group("Level", { key: "inst-level" });
    const prof = chipProfile(chipOf());
    const R = (
      g: HTMLElement,
      label: string,
      get: (x: Instrument) => number,
      set: (x: Instrument, v: number) => void,
      min: number,
      max: number,
      step: number,
      off?: string | false
    ) => {
      rangeField(g, {
        label,
        max,
        min,
        step,
        value: get(i),
        ...(off === undefined ? {} : { off }),
        onInput: (v) => edit((x) => set(x, v), label),
      });
    };
    R(
      g2.body,
      "Volume",
      (x) => x.volume,
      (x, v) => {
        x.volume = v;
      },
      0,
      1,
      0.01
    );
    R(
      g2.body,
      "Pan",
      (x) => x.pan,
      (x, v) => {
        x.pan = v;
      },
      -1,
      1,
      0.01,
      prof.constraints.pan === "none" ? `${chipName()} has no pan` : false
    );
    R(
      g2.body,
      "Transpose",
      (x) => x.transpose,
      (x, v) => {
        x.transpose = Math.round(v);
      },
      -48,
      48,
      1
    );
    R(
      g2.body,
      "Finetune",
      (x) => x.finetune,
      (x, v) => {
        x.finetune = Math.round(v);
      },
      -100,
      100,
      1
    );
    inner.append(g2.el);
    const g3 = group("Envelope", { key: "inst-env" });
    R(
      g3.body,
      "Attack",
      (x) => x.envelope.attack,
      (x, v) => {
        x.envelope.attack = v;
      },
      0,
      4,
      0.001
    );
    R(
      g3.body,
      "Decay",
      (x) => x.envelope.decay,
      (x, v) => {
        x.envelope.decay = v;
      },
      0,
      4,
      0.001
    );
    R(
      g3.body,
      "Sustain",
      (x) => x.envelope.sustain,
      (x, v) => {
        x.envelope.sustain = v;
      },
      0,
      1,
      0.01
    );
    R(
      g3.body,
      "Release",
      (x) => x.envelope.release,
      (x, v) => {
        x.envelope.release = v;
      },
      0,
      8,
      0.001
    );
    if (i.kind === "triangle") {
      note(
        g3.body,
        "On a triangle channel the envelope is a gate: a level above 0.5 is on."
      );
    }
    inner.append(g3.el);
    const g4 = group("Sends", { closed: true, key: "inst-send" });
    const fxOff =
      i.chip !== null && !prof.constraints.masterFx
        ? `${chipName()} has no master effects`
        : false;
    R(
      g4.body,
      "Echo",
      (x) => x.send.echo,
      (x, v) => {
        x.send.echo = v;
      },
      0,
      1,
      0.01,
      fxOff
    );
    R(
      g4.body,
      "Reverb",
      (x) => x.send.reverb,
      (x, v) => {
        x.send.reverb = v;
      },
      0,
      1,
      0.01,
      fxOff
    );
    inner.append(g4.el);
    inner.append(
      h("div", { class: "insp-danger" }, deleteButton(doc, "Delete instrument"))
    );
  }

  function changeKind(kind: ChannelKind): void {
    const old = inst();
    const fresh = defaultInstrument(kind, old.chip);
    project.edit<Instrument>(doc(), () => ({
      ...fresh,
      chip: old.chip,
      envelope: old.envelope,
      finetune: old.finetune,
      macros: old.macros,
      name: old.name,
      pan: old.pan,
      send: old.send,
      transpose: old.transpose,
      volume: old.volume,
    }));
    rebuildAll();
    autoPlay();
  }
  function changeChip(v: string): void {
    const chip = v === "" ? null : (v as ChipId);
    project.edit<Instrument>(doc(), (x) => {
      x.chip = chip;
      fitFmOps(x, chip);
    });
    rebuildAll();
  }

  function syncHeader(): void {
    const i = inst();
    if (document.activeElement !== nameIn) {
      nameIn.value = i.name;
    }
    const ico = q("#iIcon");
    ico.innerHTML = icon(i.kind, 20);
    ico.style.color = hex();
    host.style.setProperty("--kc", hex());
    const kb = q("#iKind");
    kb.textContent = `${KIND_LABEL[i.kind]}${i.chip ? `  ${CHIP_THEME[i.chip].short}` : "  any chip"}`;
    ctx.setChip(chipOf());
  }

  function rebuildAll(): void {
    syncHeader();
    buildKindPanel();
    buildMacros();
    buildInspector();
    showIssues(q("#iIssues"), doc().issues);
  }

  /* ----- wiring ----- */
  q("#iPlay").addEventListener("click", play);
  q("#iOctDn").addEventListener("click", () => setOctave(octave - 1));
  q("#iOctUp").addEventListener("click", () => setOctave(octave + 1));
  noteSel.addEventListener("change", () => {
    testNote = Number(noteSel.value);
    prefs.set("inst-test-note", testNote);
  });
  durIn.addEventListener("change", () => {
    testDur = clamp(Number(durIn.value) || 0.6, 0.1, 8);
    prefs.set("inst-test-dur", testDur);
  });
  durIn.addEventListener("keydown", (e) => e.stopPropagation());
  autoIn.addEventListener("change", () => {
    playOnChange = autoIn.checked;
    prefs.set("inst-play-change", playOnChange);
  });
  nameIn.addEventListener("keydown", (e) => e.stopPropagation());
  nameIn.addEventListener("input", () =>
    edit(
      (x) => {
        x.name = nameIn.value;
      },
      "name",
      false
    )
  );

  const unsub = project.subscribe((e) => {
    if (e.type === "list" && !project.get("instrument", id)) {
      app.navigate("#/pads");
      return;
    }
    if (e.type !== "doc" || e.path !== doc()?.path || e.cause === "saved") {
      return;
    }
    engine.setInstrument(id, inst());
    showIssues(q("#iIssues"), doc().issues);
    syncHeader();
    if (e.cause !== "edit") {
      rebuildAll();
    }
  });

  /* ----- visuals ----- */
  /** The key each preview channel last lit, so the engine's noteOff can put it out again. */
  const litOn = new Map<number, number>();
  /** Light the keys of the notes this instrument just played, when they are inside the two visible octaves, and put
      them out on the engine's noteOff. The engine reports a note when it becomes audible, which for a quick click is
      after the mouse is already up, so lighting without the matching release would leave the key stuck on. */
  function lightKeys(f: Frame): void {
    const lo = (octave + 1) * 12;
    for (const ev of f.events as readonly EngineEvent[]) {
      if (ev.channel < 0) {
        continue;
      }
      if (ev.type === "noteOff") {
        const n = litOn.get(ev.channel);
        if (n !== undefined) {
          piano.release(n, f.time);
          litOn.delete(ev.channel);
        }
        continue;
      }
      if (ev.type !== "noteOn" || ev.id !== id) {
        continue;
      }
      const n = Math.round(ev.note);
      if (n >= lo && n < lo + 24) {
        piano.light(n, hex(), true, f.time);
        litOn.set(ev.channel, n);
      }
    }
  }
  /** Move the macro playheads and the wavetable marker along with the note being held. */
  function movePlayheads(now: number): void {
    const active =
      wasHeld.note >= 0 && (wasHeld.released === null || now < wasHeld.until);
    for (const m of macros.values()) {
      const def = m.get();
      m.ed.mark(
        def && active
          ? macroTick(def, now - wasHeld.since, 60, wasHeld.released)
          : -1
      );
    }
    if (!active && wasHeld.note >= 0) {
      wasHeld.note = -1;
    }
    if (wavePreview && inst().kind === "wave") {
      wavePreview.mark(active ? (((now - wasHeld.since) / 1000) * 6) % 1 : -1);
    }
  }
  const offVisual = addVisual((f) => {
    lightKeys(f);
    if (piano.busy(f.time) || f.reduced) {
      piano.draw(f.time);
    }
    movePlayheads(performance.now());
  });

  rebuildAll();
  engine.setInstrument(id, inst());
  piano.draw();
  ctx.cleanup(() => {
    offVisual();
    unsub();
    autoPlay.cancel();
    document.removeEventListener("keyup", onKeyUp);
    piano.dispose();
    for (const m of macros.values()) {
      m.ed.dispose();
    }
    for (const n of heldKeys.values()) {
      noteUp(n);
    }
    releaseNote();
  });

  const commands = (): Command[] => [
    {
      group: "Instrument",
      icon: "play",
      id: "inst:play",
      keys: "Space",
      run: play,
      title: "Play the test note",
    },
    {
      group: "Instrument",
      icon: "up",
      id: "inst:oct-up",
      keys: "=",
      run: () => setOctave(octave + 1),
      title: "Keyboard octave up",
    },
    {
      group: "Instrument",
      icon: "down",
      id: "inst:oct-down",
      keys: "-",
      run: () => setOctave(octave - 1),
      title: "Keyboard octave down",
    },
  ];

  return {
    chip: () => chipOf(),
    commands,
    doc: () => doc(),
    onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) {
        return false;
      }
      if (e.key === "-") {
        setOctave(octave - 1);
        return true;
      }
      if (e.key === "=" || e.key === "+") {
        setOctave(octave + 1);
        return true;
      }
      const off = keyToOffset(e.key);
      if (off === null || e.key.length !== 1 || off >= 24) {
        return false;
      }
      const lower = e.key.toLowerCase();
      if (heldKeys.has(lower)) {
        return true;
      }
      const n = (octave + 1) * 12 + off;
      heldKeys.set(lower, n);
      noteDown(n);
      return true;
    },
    play,
    stop: stopEverything,
  };
}
