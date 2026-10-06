/* The SFX editor: a big waveform that redraws from a fresh render after every change (rendered in a worker, debounced
   60 ms), a spectrogram toggle, and an inspector with every field of an sfx grouped the way sfxr groups them. Fields the
   chip does not have are greyed out with a tooltip that says why. */
import type { Command, ViewHooks } from "../app.ts";
import { app } from "../app.ts";
import {
  CHIP_THEME,
  CHIP_WAVES,
  categoryColor,
  chipTheme,
} from "../lib/chips.ts";
import {
  CHIP_IDS,
  type ChipId,
  type RenderResult,
  SFX_CATEGORIES,
  type Sfx,
  type SfxWave,
} from "../lib/contract.ts";
import {
  chipProfile,
  describeSfx,
  mutateSfx,
  randomizeSfx,
} from "../lib/core.ts";
import { debounce, h, prefs } from "../lib/dom.ts";
import { playSfx, stopEverything } from "../playback.ts";
import { playLength, renderSfxAsync } from "../render-service.ts";
import type { ViewCtx } from "../shell.ts";
import { type Doc, project } from "../state/docs.ts";
import {
  type FieldHandle,
  type Group,
  group,
  note,
  rangeField,
  selectField,
  textField,
  toggleField,
} from "../ui/fields.ts";
import { icon } from "../ui/icons.ts";
import { showIssues } from "../ui/issues.ts";
import { presetTable, type WaveGrid, waveGrid } from "../ui/wavegrid.ts";
import { surface } from "../visuals/canvas.ts";
import { addVisual } from "../visuals/loop.ts";
import {
  drawSpectrogram,
  drawWaveform,
  makeSpectrogram,
} from "../visuals/waveform.ts";

const LIST_SEPARATOR = /[\s,]+/;

/** Which top level fields each lock group keeps while randomizing or mutating. */
const GROUP_FIELDS: Record<string, readonly (keyof Sfx)[]> = {
  arpeggio: ["arpeggio"],
  crush: ["bitcrush"],
  duty: ["duty"],
  envelope: ["envelope"],
  filter: ["filter"],
  frequency: ["frequency"],
  phaser: ["phaser"],
  repeat: ["repeat"],
  vibrato: ["vibrato"],
  wave: ["wave", "noise", "fm", "table"],
};

const ARP_TEXT = (steps: readonly number[]) => steps.join(" ");
const parseArp = (s: string): number[] =>
  s
    .split(LIST_SEPARATOR)
    .filter(Boolean)
    .map((t) => Math.round(Number(t)))
    .filter((n) => Number.isFinite(n))
    .slice(0, 8);

export function mountSfx(ctx: ViewCtx, id: string): ViewHooks {
  const { host, insp } = ctx;
  const doc = (): Doc<Sfx> => project.get<Sfx>("sfx", id) as Doc<Sfx>;
  const sfxNow = () => doc().value;
  let seedN = (project.project.seed || 1) * 7919 + (Date.now() % 100_000);
  const nextSeed = () => {
    seedN += 1;
    return seedN;
  };
  let playOnChange = prefs.get("sfx-play-change", true);
  let showSpec = prefs.get("sfx-spec", false);
  let render: RenderResult | null = null;
  let spec: HTMLCanvasElement | null = null;
  let playStart = -1;
  let dirtyDraw = true;

  host.innerHTML = `
    <div class="ed sfx-ed">
      <div class="ed-head">
        <div class="ed-title">
          <span class="big-ico" id="sIcon"></span>
          <input class="nm-in" id="sName" aria-label="Sound name" maxlength="60" spellcheck="false">
        </div>
        <div class="ed-sel">
          <label class="sel"><span>Chip</span><select id="sChip" aria-label="Chip"></select></label>
          <label class="sel"><span>Type</span><select id="sCat" aria-label="Category"></select></label>
        </div>
        <div class="ed-actions">
          <button class="btn primary big" id="sPlay" title="Play (Space)">${icon("play", 16)}<span>Play</span></button>
          <button class="btn" id="sRand" title="Randomize (R)">${icon("dice", 14)}<span>Randomize</span></button>
          <button class="btn" id="sMut" title="Mutate (M)">${icon("shuffle", 14)}<span>Mutate</span></button>
          <label class="tgl-row" title="Play the sound after each change"><span class="tgl"><input type="checkbox" id="sAuto"><span></span></span><small>Play on every change</small></label>
        </div>
      </div>
      <div class="chip-hint" id="sHint"></div>
      <div class="wavebox" id="sWaveBox"><canvas id="sWave" aria-label="Waveform"></canvas><span class="wtag mono" id="sInfo"></span></div>
      <div class="wavebox spec" id="sSpecBox"><canvas id="sSpec" aria-label="Spectrogram"></canvas><span class="wtag mono">spectrogram</span></div>
      <div class="ed-foot">
        <button class="btn small" id="sSpecBtn" aria-pressed="false">${icon("chart", 12)}<span>Spectrogram</span></button>
        <button class="btn small" id="sAna">${icon("chart", 12)}<span>Analyse</span></button>
        <p class="desc" id="sDesc"></p>
      </div>
    </div>`;
  const q = <T extends HTMLElement>(sel: string) =>
    host.querySelector(sel) as T;
  const nameIn = q<HTMLInputElement>("#sName");
  const chipSel = q<HTMLSelectElement>("#sChip");
  const catSel = q<HTMLSelectElement>("#sCat");
  const autoIn = q<HTMLInputElement>("#sAuto");
  const hint = q("#sHint");
  const info = q("#sInfo");
  const desc = q("#sDesc");
  const specBox = q("#sSpecBox");
  const specBtn = q("#sSpecBtn");
  const waveSurf = surface(q<HTMLCanvasElement>("#sWave"));
  const specSurf = surface(q<HTMLCanvasElement>("#sSpec"));
  for (const c of CHIP_IDS) {
    chipSel.append(h("option", { value: c }, CHIP_THEME[c].short));
  }
  for (const c of SFX_CATEGORIES) {
    catSel.append(h("option", { value: c }, c[0]?.toUpperCase() + c.slice(1)));
  }
  autoIn.checked = playOnChange;

  /* ----- drawing ----- */
  const color = () => categoryColor(sfxNow().category);
  const redraw = () => {
    const played =
      playStart < 0
        ? -1
        : Math.min(
            1.02,
            (performance.now() - playStart) /
              1000 /
              Math.max(0.05, playLength(sfxNow()) + 0.05)
          );
    drawWaveform(waveSurf, render, {
      clip: true,
      color: color(),
      played: played > 1 ? -1 : played,
    });
    if (showSpec) {
      drawSpectrogram(specSurf, spec, played > 1 ? -1 : played);
    }
    if (played > 1) {
      playStart = -1;
    }
    dirtyDraw = false;
  };
  const refreshRender = debounce(() => {
    const sfx = sfxNow();
    renderSfxAsync(sfx, 44_100)
      .then((r) => {
        if (JSON.stringify(sfx) !== JSON.stringify(sfxNow())) {
          return;
        }
        render = r;
        spec = showSpec
          ? makeSpectrogram(r, 320, 128, chipTheme(sfx.chip).ramp)
          : null;
        const dur = r.frames / r.sampleRate;
        info.textContent = `${dur.toFixed(2)}s  ${CHIP_THEME[sfx.chip].short}  ${sfx.wave}`;
        dirtyDraw = true;
      })
      .catch(() => {
        render = null;
        dirtyDraw = true;
      });
  }, 60);
  const off = addVisual((f) => {
    if (playStart >= 0 || dirtyDraw) {
      redraw();
    } else if (f.reduced) {
      redraw();
    }
  });

  /* ----- playing ----- */
  const play = () => {
    playStart = performance.now();
    playSfx(doc());
  };
  const autoPlay = debounce(() => {
    if (playOnChange) {
      play();
    }
  }, 140);

  /* ----- editing ----- */
  const edit = (fn: (d: Sfx) => void, key: string) => {
    project.edit<Sfx>(doc(), fn, `sfx:${key}`);
  };

  const groups: Record<string, Group> = {};
  /* Locked groups, by key. The inspector is rebuilt after every randomize and mutate, so the lock lives here and not
     in the group: it holds until the user unlocks it. */
  const locks = new Set<string>();
  const handles: Record<string, FieldHandle | undefined> = {};
  let wg: WaveGrid | null = null;

  const profile = () => chipProfile(sfxNow().chip);
  const chipName = () => CHIP_THEME[sfxNow().chip].short;

  const FILTER_FIELDS = [
    "lpOn",
    "lpHz",
    "lpSweep",
    "res",
    "hpOn",
    "hpHz",
    "hpSweep",
  ];
  /** The filter group: greyed whole when the chip has no filter, else each knob follows its own switch. */
  function applyFilterOff(s: Sfx, cn: string, notes: string[]): void {
    if (!profile().constraints.filter) {
      for (const k of FILTER_FIELDS) {
        handles[k]?.setOff(`${cn} has no filter`);
      }
      notes.push(`${cn} has no filter, so the Filter group is greyed out.`);
      return;
    }
    handles.lpOn?.setOff(false);
    handles.hpOn?.setOff(false);
    const lp = s.filter.lowpass === null ? "Turn Lowpass on first" : false;
    const hp = s.filter.highpass === null ? "Turn Highpass on first" : false;
    for (const k of ["lpHz", "lpSweep", "res"]) {
      handles[k]?.setOff(lp);
    }
    for (const k of ["hpHz", "hpSweep"]) {
      handles[k]?.setOff(hp);
    }
  }
  /** Duty only shapes the square wave, noise mode only the noise wave; the chip's own limits go in the hint. */
  function applyShapeOff(s: Sfx, cn: string, notes: string[]): void {
    const c = profile();
    const dutyOff =
      s.wave === "square"
        ? false
        : `Duty only shapes the square wave (this one is ${s.wave})`;
    handles.dutyStart?.setOff(dutyOff);
    handles.dutySweep?.setOff(dutyOff);
    if (c.constraints.dutyCycles.length > 0 && s.wave === "square") {
      const widths = c.constraints.dutyCycles.map(
        (d) => `${Math.round(d * 100)}%`
      );
      notes.push(`${cn} snaps pulse width to ${widths.join(", ")}.`);
    }
    handles.noiseMode?.setOff(
      s.wave === "noise" ? false : "Noise mode only applies to the noise wave"
    );
    handles.bits?.setOff(false);
    if (c.constraints.volumeSteps > 0) {
      notes.push(
        `${cn} has ${c.constraints.volumeSteps} volume steps per channel.`
      );
    }
  }
  /** Hide the FM and wavetable groups unless the wave uses them; mark waves the chip cannot play. */
  function applyWaveOptions(s: Sfx, cn: string): void {
    if (groups.fm) {
      groups.fm.el.hidden = s.wave !== "fm";
    }
    if (groups.table) {
      groups.table.el.hidden = s.wave !== "wave";
    }
    const waveSel = handles.wave as
      | (FieldHandle & { select: HTMLSelectElement })
      | undefined;
    for (const opt of Array.from(waveSel?.select.options ?? [])) {
      const ok = CHIP_WAVES[s.chip].includes(opt.value as SfxWave);
      opt.disabled = !ok;
      opt.textContent = ok ? opt.value : `${opt.value} (not on ${cn})`;
    }
  }
  /** Grey out what the chip or wave does not have, and say why. */
  function applyOff(): void {
    const s = sfxNow();
    const cn = chipName();
    const notes: string[] = [];
    applyFilterOff(s, cn, notes);
    applyShapeOff(s, cn, notes);
    applyWaveOptions(s, cn);
    hint.textContent = notes.join(" ");
    hint.hidden = notes.length === 0;
  }

  function buildInspector(): void {
    insp.replaceChildren();
    wg = null;
    const s = sfxNow();
    const inner = h("div", { class: "insp-in" });
    insp.append(inner);
    const box = h("div", { class: "issue-slot" });
    showIssues(box, doc().issues);
    inner.append(box);

    const mk = (key: string, title: string, o: { closed?: boolean } = {}) => {
      const g = group(title, {
        key: `sfx-${key}`,
        lock: true,
        locked: locks.has(key),
        onLock: (on) => {
          if (on) {
            locks.add(key);
          } else {
            locks.delete(key);
          }
        },
        ...o,
      });
      groups[key] = g;
      inner.append(g.el);
      return g;
    };
    const R = (
      g: Group,
      hkey: string,
      label: string,
      get: (d: Sfx) => number,
      set: (d: Sfx, v: number) => void,
      min: number,
      max: number,
      step: number,
      extra: { scale?: "log"; title?: string } = {}
    ) => {
      handles[hkey] = rangeField(g.body, {
        label,
        max,
        min,
        step,
        value: get(s),
        ...extra,
        onInput: (v) => {
          edit((d) => set(d, v), hkey);
          autoPlay();
        },
      });
    };

    // Wave
    const gw = mk("wave", "Wave");
    handles.wave = selectField<SfxWave>(gw.body, {
      label: "Wave",
      onInput: (v) => {
        edit((d) => {
          d.wave = v;
          if (v === "fm" && !d.fm) {
            d.fm = { index: 2, indexDecay: 0.3, ratio: 2 };
          }
          if (v === "wave" && !d.table) {
            d.table = presetTable("sine");
          }
        }, "wave");
        autoPlay();
        wg?.set(sfxNow().table ?? presetTable("sine"));
      },
      options: CHIP_WAVES[s.chip],
      value: s.wave,
    });
    const wsel = handles.wave as FieldHandle & { select: HTMLSelectElement };
    // all waves listed so a disallowed one shows greyed with the reason
    wsel.select.replaceChildren();
    for (const w of [
      "square",
      "triangle",
      "saw",
      "sine",
      "noise",
      "wave",
      "fm",
    ]) {
      wsel.select.append(h("option", { value: w }, w));
    }
    wsel.select.value = s.wave;
    R(
      gw,
      "volume",
      "Volume",
      (d) => d.volume,
      (d, v) => {
        d.volume = v;
      },
      0,
      1,
      0.01
    );
    handles.noiseMode = selectField<"long" | "short">(gw.body, {
      label: "Noise mode",
      onInput: (v) => {
        edit((d) => {
          d.noise.mode = v;
        }, "noise");
        autoPlay();
      },
      options: ["long", "short"],
      value: s.noise.mode,
    });

    // FM (only for the fm wave)
    const gf = mk("fmx", "FM patch");
    groups.fm = gf;
    const fm = s.fm ?? { index: 2, indexDecay: 0.3, ratio: 2 };
    for (const [k, label, min, max, step] of [
      ["ratio", "Ratio", 0.5, 12, 0.01],
      ["index", "Index", 0, 8, 0.01],
      ["indexDecay", "Index decay", 0, 2, 0.01],
    ] as const) {
      handles[`fm${k}`] = rangeField(gf.body, {
        label,
        max,
        min,
        onInput: (v) => {
          edit((d) => {
            d.fm = {
              ...(d.fm ?? { index: 2, indexDecay: 0.3, ratio: 2 }),
              [k]: v,
            };
          }, `fm${k}`);
          autoPlay();
        },
        step,
        value: fm[k],
      });
    }

    // Table (only for the wave wave)
    const gt = mk("table", "Wave table");
    groups.table = gt;
    wg = waveGrid({
      color: categoryColor(s.category),
      onChange: (t) => {
        edit((d) => {
          d.table = t;
        }, "table");
        autoPlay();
      },
      table: s.table ?? presetTable("sine"),
    });
    gt.body.append(wg.el);

    // Envelope
    const ge = mk("envelope", "Envelope");
    R(
      ge,
      "attack",
      "Attack",
      (d) => d.envelope.attack,
      (d, v) => {
        d.envelope.attack = v;
      },
      0,
      2,
      0.001,
      { title: "Seconds to fade in" }
    );
    R(
      ge,
      "sustain",
      "Sustain",
      (d) => d.envelope.sustain,
      (d, v) => {
        d.envelope.sustain = v;
      },
      0,
      3,
      0.001,
      { title: "Seconds held at full level" }
    );
    R(
      ge,
      "punch",
      "Punch",
      (d) => d.envelope.punch,
      (d, v) => {
        d.envelope.punch = v;
      },
      0,
      1,
      0.01,
      { title: "Extra level at the start of the sustain" }
    );
    R(
      ge,
      "decay",
      "Decay",
      (d) => d.envelope.decay,
      (d, v) => {
        d.envelope.decay = v;
      },
      0,
      3,
      0.001,
      { title: "Seconds to fade out" }
    );

    // Frequency
    const gq = mk("frequency", "Frequency");
    R(
      gq,
      "fstart",
      "Start (Hz)",
      (d) => d.frequency.start,
      (d, v) => {
        d.frequency.start = v;
      },
      20,
      8000,
      1,
      { scale: "log" }
    );
    R(
      gq,
      "fmin",
      "Cut-off (Hz)",
      (d) => d.frequency.min,
      (d, v) => {
        d.frequency.min = v;
      },
      0,
      8000,
      1,
      {
        title: "Stop the sound when the pitch falls below this. 0 turns it off",
      }
    );
    R(
      gq,
      "slide",
      "Slide",
      (d) => d.frequency.slide,
      (d, v) => {
        d.frequency.slide = v;
      },
      -8,
      8,
      0.01,
      { title: "Octaves per second" }
    );
    R(
      gq,
      "dslide",
      "Delta slide",
      (d) => d.frequency.deltaSlide,
      (d, v) => {
        d.frequency.deltaSlide = v;
      },
      -16,
      16,
      0.01,
      { title: "Octaves per second, per second" }
    );

    // Vibrato
    const gv = mk("vibrato", "Vibrato", { closed: true });
    R(
      gv,
      "vdepth",
      "Depth",
      (d) => d.vibrato.depth,
      (d, v) => {
        d.vibrato.depth = v;
      },
      0,
      2,
      0.01,
      { title: "Semitones" }
    );
    R(
      gv,
      "vrate",
      "Rate (Hz)",
      (d) => d.vibrato.rate,
      (d, v) => {
        d.vibrato.rate = v;
      },
      0,
      40,
      0.1
    );

    // Arpeggio
    const ga = mk("arpeggio", "Arpeggio", { closed: true });
    const arp = textField(ga.body, {
      label: "Steps",
      onInput: (v) => {
        edit((d) => {
          d.arpeggio.steps = parseArp(v);
        }, "arpsteps");
        autoPlay();
      },
      placeholder: "0 4 7",
      value: ARP_TEXT(s.arpeggio.steps),
    });
    arp.title =
      "Semitone steps cycled at the rate, like 0 4 7. Empty turns it off";
    R(
      ga,
      "arate",
      "Rate (Hz)",
      (d) => d.arpeggio.rate,
      (d, v) => {
        d.arpeggio.rate = v;
      },
      0,
      60,
      0.1
    );

    // Duty
    const gd = mk("duty", "Duty", { closed: true });
    R(
      gd,
      "dutyStart",
      "Pulse width",
      (d) => d.duty.start,
      (d, v) => {
        d.duty.start = v;
      },
      0,
      1,
      0.01
    );
    R(
      gd,
      "dutySweep",
      "Sweep",
      (d) => d.duty.sweep,
      (d, v) => {
        d.duty.sweep = v;
      },
      -4,
      4,
      0.01,
      { title: "Change of pulse width per second" }
    );
    handles.dutyStart = handles.dutyStart as FieldHandle;

    // Repeat
    const gr = mk("repeat", "Repeat", { closed: true });
    R(
      gr,
      "rrate",
      "Rate (Hz)",
      (d) => d.repeat.rate,
      (d, v) => {
        d.repeat.rate = v;
      },
      0,
      60,
      0.1,
      { title: "Restart the envelope and pitch this often. 0 turns it off" }
    );

    // Phaser
    const gp = mk("phaser", "Phaser", { closed: true });
    R(
      gp,
      "poff",
      "Offset (ms)",
      (d) => d.phaser.offset,
      (d, v) => {
        d.phaser.offset = v;
      },
      -20,
      20,
      0.1
    );
    R(
      gp,
      "psweep",
      "Sweep (ms/s)",
      (d) => d.phaser.sweep,
      (d, v) => {
        d.phaser.sweep = v;
      },
      -40,
      40,
      0.1
    );

    // Filter
    const gl = mk("filter", "Filter", { closed: true });
    handles.lpOn = toggleField(gl.body, {
      label: "Lowpass",
      onInput: (on) => {
        edit((d) => {
          d.filter.lowpass = on ? (d.filter.lowpass ?? 2000) : null;
        }, "lpon");
        applyOff();
        autoPlay();
      },
      value: s.filter.lowpass !== null,
    });
    R(
      gl,
      "lpHz",
      "Cutoff (Hz)",
      (d) => d.filter.lowpass ?? 2000,
      (d, v) => {
        d.filter.lowpass = v;
      },
      50,
      20_000,
      1,
      { scale: "log" }
    );
    R(
      gl,
      "lpSweep",
      "Sweep (oct/s)",
      (d) => d.filter.lowpassSweep,
      (d, v) => {
        d.filter.lowpassSweep = v;
      },
      -8,
      8,
      0.01
    );
    R(
      gl,
      "res",
      "Resonance",
      (d) => d.filter.resonance,
      (d, v) => {
        d.filter.resonance = v;
      },
      0,
      1,
      0.01
    );
    handles.hpOn = toggleField(gl.body, {
      label: "Highpass",
      onInput: (on) => {
        edit((d) => {
          d.filter.highpass = on ? (d.filter.highpass ?? 300) : null;
        }, "hpon");
        applyOff();
        autoPlay();
      },
      value: s.filter.highpass !== null,
    });
    R(
      gl,
      "hpHz",
      "Cutoff (Hz)",
      (d) => d.filter.highpass ?? 300,
      (d, v) => {
        d.filter.highpass = v;
      },
      20,
      10_000,
      1,
      { scale: "log" }
    );
    R(
      gl,
      "hpSweep",
      "Sweep (oct/s)",
      (d) => d.filter.highpassSweep,
      (d, v) => {
        d.filter.highpassSweep = v;
      },
      -8,
      8,
      0.01
    );

    // Crush
    const gc = mk("crush", "Crush", { closed: true });
    toggleField(gc.body, {
      label: "Bit crush",
      onInput: (on) => {
        edit((d) => {
          d.bitcrush.bits = on ? (d.bitcrush.bits ?? 8) : null;
        }, "bitson");
        handles.bits?.setOff(on ? false : "Turn Bit crush on first");
        autoPlay();
      },
      value: s.bitcrush.bits !== null,
    });
    R(
      gc,
      "bits",
      "Bits",
      (d) => d.bitcrush.bits ?? 8,
      (d, v) => {
        d.bitcrush.bits = Math.round(v);
      },
      1,
      16,
      1
    );
    R(
      gc,
      "rdiv",
      "Rate divide",
      (d) => d.bitcrush.rateDivide,
      (d, v) => {
        d.bitcrush.rateDivide = Math.round(v);
      },
      1,
      64,
      1,
      { title: "Hold each sample this many times" }
    );
    handles.bits?.setOff(
      s.bitcrush.bits === null ? "Turn Bit crush on first" : false
    );

    note(
      inner,
      "Lock a group with its padlock to keep it while you randomize or mutate."
    );
    applyOff();
  }

  function syncHeader(): void {
    const s = sfxNow();
    if (document.activeElement !== nameIn) {
      nameIn.value = s.name;
    }
    chipSel.value = s.chip;
    catSel.value = s.category;
    const ico = q("#sIcon");
    ico.innerHTML = icon(s.category, 20);
    ico.style.color = categoryColor(s.category);
    host.style.setProperty("--kc", categoryColor(s.category));
    desc.textContent = describeSfx(s);
    ctx.setChip(s.chip);
  }

  /* ----- randomize and mutate (locks respected) ----- */
  function keepLocked(old: Sfx, next: Sfx): Sfx {
    const out = {
      ...next,
      category: old.category,
      chip: old.chip,
      name: old.name,
      volume: old.volume,
    } as Sfx;
    for (const [key, g] of Object.entries(groups)) {
      if (g.locked()) {
        for (const f of GROUP_FIELDS[key] ?? []) {
          (out as unknown as Record<string, unknown>)[f] = JSON.parse(
            JSON.stringify(old[f])
          );
        }
      }
    }
    return out;
  }
  function randomize(): void {
    const old = sfxNow();
    project.edit<Sfx>(doc(), () =>
      keepLocked(old, randomizeSfx(old, nextSeed()))
    );
    buildInspector();
    play();
  }
  function mutate(): void {
    const old = sfxNow();
    project.edit<Sfx>(doc(), () =>
      keepLocked(old, mutateSfx(old, { amount: 0.25, seed: nextSeed() }))
    );
    buildInspector();
    play();
  }

  /* ----- wiring ----- */
  q("#sPlay").addEventListener("click", play);
  q("#sRand").addEventListener("click", randomize);
  q("#sMut").addEventListener("click", mutate);
  q("#sAna").addEventListener("click", () =>
    app.navigate(`#/analysis/sfx/${id}`)
  );
  autoIn.addEventListener("change", () => {
    playOnChange = autoIn.checked;
    prefs.set("sfx-play-change", playOnChange);
  });
  const setSpec = (on: boolean) => {
    showSpec = on;
    prefs.set("sfx-spec", on);
    specBox.hidden = !on;
    specBtn.classList.toggle("on", on);
    specBtn.setAttribute("aria-pressed", String(on));
    if (on && render) {
      spec = makeSpectrogram(render, 320, 128, chipTheme(sfxNow().chip).ramp);
    }
    dirtyDraw = true;
    requestAnimationFrame(() => {
      waveSurf.fit();
      specSurf.fit();
      dirtyDraw = true;
    });
  };
  specBtn.addEventListener("click", () => setSpec(!showSpec));
  setSpec(showSpec);
  nameIn.addEventListener("keydown", (e) => e.stopPropagation());
  nameIn.addEventListener("input", () =>
    edit((d) => {
      d.name = nameIn.value;
    }, "name")
  );
  chipSel.addEventListener("change", () => {
    edit((d) => {
      d.chip = chipSel.value as ChipId;
    }, "chip");
    buildInspector();
  });
  catSel.addEventListener("change", () => {
    edit((d) => {
      d.category = catSel.value as Sfx["category"];
    }, "category");
  });

  const unsub = project.subscribe((e) => {
    if (e.type === "list" && !project.get("sfx", id)) {
      app.navigate("#/pads");
      return;
    }
    if (e.type === "project") {
      // the master volume and limiter shape the render
      refreshRender();
      return;
    }
    if (e.type !== "doc" || e.path !== doc().path) {
      return;
    }
    syncHeader();
    applyOff();
    refreshRender();
    showIssues(insp.querySelector(".issue-slot"), doc().issues);
    if (
      e.cause === "undo" ||
      e.cause === "external" ||
      e.cause === "conflict"
    ) {
      buildInspector();
    }
  });

  syncHeader();
  buildInspector();
  refreshRender();
  refreshRender.flush();
  ctx.cleanup(() => {
    off();
    unsub();
    refreshRender.cancel();
    autoPlay.cancel();
    waveSurf.dispose();
    specSurf.dispose();
  });

  const commands = (): Command[] => [
    {
      group: "SFX",
      icon: "play",
      id: "sfx:play",
      keys: "Space",
      run: play,
      title: "Play this sound",
    },
    {
      group: "SFX",
      icon: "dice",
      id: "sfx:random",
      keys: "R",
      run: randomize,
      title: "Randomize this sound",
    },
    {
      group: "SFX",
      icon: "shuffle",
      id: "sfx:mutate",
      keys: "M",
      run: mutate,
      title: "Mutate this sound",
    },
    {
      group: "SFX",
      icon: "chart",
      id: "sfx:spec",
      run: () => setSpec(!showSpec),
      title: "Toggle spectrogram",
    },
  ];

  return {
    chip: () => sfxNow().chip,
    commands,
    doc: () => doc(),
    onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return false;
      }
      if (e.key === "r" || e.key === "R") {
        randomize();
        return true;
      }
      if (e.key === "m" || e.key === "M") {
        mutate();
        return true;
      }
      return false;
    },
    play,
    stop: stopEverything,
  };
}
