/* The sample editor: a recording the person imported (or a module's sample), shown as a waveform with a trim selection
   and loop points that can be dragged, a keyboard to play it, and the inspector for what a sample instrument needs to
   know: base note (with pitch detection), fine tune, volume, loop, bit depth. Edits are normal project edits, so they
   save, undo and reach the engine like any other. The audio itself is only ever re-encoded by lib/sample-edit.ts. */
import type { Command, ViewHooks } from "../app.ts";
import { app } from "../app.ts";
import { engine } from "../engine/engine.ts";
import { licenseBadge } from "../freesound/badge.ts";
import { KIND_HEX } from "../lib/chips.ts";
import type { Instrument, UserSample } from "../lib/contract.ts";
import { noteName } from "../lib/core.ts";
import { clamp, fire, h } from "../lib/dom.ts";
import {
  describeSample,
  floatsOf,
  framesOf,
  normalized,
  peakLevel,
  peaksOf,
  pitchOf,
  trimTo,
  withBits,
} from "../lib/sample-edit.ts";
import { previewSampleNote, releaseNote, stopEverything } from "../playback.ts";
import type { ViewCtx } from "../shell.ts";
import { type Doc, project } from "../state/docs.ts";
import { docActions } from "../ui/delete-doc.ts";
import {
  bindName,
  group,
  note,
  rangeField,
  selectField,
  textField,
  toggleField,
} from "../ui/fields.ts";
import { icon } from "../ui/icons.ts";
import { createSampleInstrument } from "../ui/import-audio.ts";
import { showIssues } from "../ui/issues.ts";
import { createKeyboard } from "../ui/keyboard.ts";
import { rgba, surface } from "../visuals/canvas.ts";
import { addVisual } from "../visuals/loop.ts";

const HIT = 7;
const LOOP_START = "#74c08f";
const LOOP_END = "#b49ae6";

type Drag =
  | { kind: "select"; from: number }
  | { kind: "loopStart" }
  | { kind: "loopEnd" };

export function mountSample(ctx: ViewCtx, id: string): ViewHooks {
  const { host, insp } = ctx;
  const doc = (): Doc<UserSample> =>
    project.get<UserSample>("sample", id) as Doc<UserSample>;
  const sample = () => doc().value;
  const hex = KIND_HEX.sample;
  let sel: { a: number; b: number } | null = null;
  let drag: Drag | null = null;
  const heldNotes = new Map<number, number>();
  /** The note being played, for the playhead on the waveform. */
  const playing = { note: -1, since: 0, until: 0 };

  host.innerHTML = `
    <div class="ed sample-ed">
      <div class="ed-head">
        <div class="ed-title">
          <span class="big-ico" id="sIcon">${icon("sample", 20)}</span>
          <input class="nm-in" id="sName" aria-label="Sample name" maxlength="60" spellcheck="false">
        </div>
        <div class="ed-sel"><span class="kind-badge" id="sKind">Sample</span><span id="sLic"></span></div>
        <div class="ed-actions test-row">
          <button class="btn primary big" id="sPlay" title="Play the sample at its base note (Space)">${icon("play", 16)}<span>Play</span></button>
          <button class="btn big" id="sMake" title="Make a sample instrument that plays this sample">${icon("plus", 14)}<span>Make instrument</span></button>
        </div>
      </div>
      <section class="card">
        <div class="card-h"><h3 class="pxh">Waveform</h3><span class="muted" id="sInfo"></span></div>
        <div class="card-b">
          <canvas class="sample-wave" id="sWave" aria-label="Sample waveform" tabindex="0"></canvas>
          <div class="wave-tools">
            <span class="muted" id="sHint">Drag to select a part. Drag the green and purple loop markers.</span>
            <span class="wave-btns">
              <button class="btn small" id="sTrim" title="Keep only the selected part">${icon("check", 12)}<span>Trim to selection</span></button>
              <button class="btn small" id="sClear" title="Clear the selection">${icon("close", 12)}<span>Clear selection</span></button>
            </span>
          </div>
        </div>
      </section>
      <div class="kb-wrap">
        <div class="kb-head"><span class="pxh">Keyboard</span><span class="hint2">Play the sample at any pitch with the mouse or the keys Z S X D C V G B H N J M and Q 2 W 3 E R 5 T 6 Y 7 U</span>
          <span class="oct"><button class="btn icon small" id="sOctDn" aria-label="Octave down">${icon("minus", 12)}</button><b class="mono" id="sOct"></b><button class="btn icon small" id="sOctUp" aria-label="Octave up">${icon("plus", 12)}</button></span></div>
        <canvas class="kb" id="sKeys" aria-label="Piano keyboard"></canvas>
      </div>
      <div class="issue-slot" id="sIssues"></div>
      <section class="card" id="sUsed"></section>
    </div>`;
  const q = <T extends HTMLElement>(sel2: string) =>
    host.querySelector(sel2) as T;
  const nameIn = q<HTMLInputElement>("#sName");
  const waveCv = q<HTMLCanvasElement>("#sWave");
  const trimBtn = q<HTMLButtonElement>("#sTrim");
  const clearBtn = q<HTMLButtonElement>("#sClear");
  const wave = surface(waveCv);

  /* ----- editing ----- */
  const edit = (fn: (d: UserSample) => unknown, key: string) =>
    project.edit<UserSample>(doc(), fn, `sample:${key}`);

  /* ----- the waveform ----- */
  const frameAt = (x: number): number =>
    clamp(
      Math.round((x / Math.max(1, wave.w)) * framesOf(sample())),
      0,
      framesOf(sample())
    );
  const xOf = (frame: number): number =>
    (frame / Math.max(1, framesOf(sample()))) * wave.w;

  function drawMarkers(s: UserSample): void {
    const g = wave.ctx;
    if (!s.loop) {
      return;
    }
    const x0 = xOf(s.loop.start);
    const x1 = xOf(s.loop.end);
    g.fillStyle = rgba(LOOP_START, 0.12);
    g.fillRect(x0, 0, Math.max(1, x1 - x0), wave.h);
    g.fillStyle = LOOP_START;
    g.fillRect(Math.round(x0), 0, 2, wave.h);
    g.fillRect(Math.round(x0), 0, 8, 6);
    g.fillStyle = LOOP_END;
    g.fillRect(Math.round(x1) - 2, 0, 2, wave.h);
    g.fillRect(Math.round(x1) - 6, wave.h - 6, 8, 6);
  }

  function draw(): void {
    wave.fit();
    const g = wave.ctx;
    const s = sample();
    g.fillStyle = "#0e0d14";
    g.fillRect(0, 0, wave.w, wave.h);
    g.fillStyle = "#1c1a28";
    g.fillRect(0, Math.round(wave.h / 2), wave.w, 1);
    if (sel) {
      const x0 = xOf(Math.min(sel.a, sel.b));
      const x1 = xOf(Math.max(sel.a, sel.b));
      g.fillStyle = rgba("#ece7da", 0.14);
      g.fillRect(x0, 0, Math.max(1, x1 - x0), wave.h);
    }
    const cols = Math.max(1, Math.floor(wave.w));
    const peaks = peaksOf(floatsOf(s), cols);
    const mid = wave.h / 2;
    g.fillStyle = hex;
    for (let x = 0; x < cols; x += 1) {
      const lo = peaks[2 * x] ?? 0;
      const hi = peaks[2 * x + 1] ?? 0;
      const top = Math.round(mid - hi * (mid - 3));
      const bot = Math.round(mid - lo * (mid - 3));
      g.fillRect(x, top, 1, Math.max(1, bot - top));
    }
    drawMarkers(s);
  }

  /** Where the sample is while a note plays: the frame, following the pitch ratio and the loop. */
  function playhead(now: number): number {
    if (playing.note < 0 || now > playing.until) {
      return -1;
    }
    const s = sample();
    const ratio = 2 ** ((playing.note - (s.baseNote - s.finetune / 100)) / 12);
    let pos = ((now - playing.since) / 1000) * s.rate * ratio;
    if (s.loop && pos >= s.loop.end) {
      const span = s.loop.end - s.loop.start;
      pos = s.loop.start + ((pos - s.loop.start) % span);
    }
    return pos < framesOf(s) ? pos : -1;
  }

  function drawPlayhead(now: number): void {
    const pos = playhead(now);
    if (pos < 0) {
      return;
    }
    const x = Math.round(xOf(pos));
    wave.ctx.fillStyle = "#ece7da";
    wave.ctx.fillRect(x, 0, 1, wave.h);
  }

  /* ----- pointer: select a part, drag the loop markers ----- */
  function hitMarker(x: number): "loopStart" | "loopEnd" | null {
    const { loop } = sample();
    if (!loop) {
      return null;
    }
    const ds = Math.abs(x - xOf(loop.start));
    const de = Math.abs(x - xOf(loop.end));
    if (Math.min(ds, de) > HIT) {
      return null;
    }
    return ds <= de ? "loopStart" : "loopEnd";
  }

  const localX = (e: PointerEvent): number =>
    e.clientX - waveCv.getBoundingClientRect().left;

  function moveMarker(kind: "loopStart" | "loopEnd", frame: number): void {
    edit((d) => {
      if (!d.loop) {
        return;
      }
      const total = framesOf(d);
      if (kind === "loopStart") {
        d.loop.start = clamp(frame, 0, d.loop.end - 2);
      } else {
        d.loop.end = clamp(frame, d.loop.start + 2, total);
      }
    }, "loop");
  }

  waveCv.addEventListener("pointerdown", (e) => {
    const x = localX(e);
    const hit = hitMarker(x);
    drag = hit ? { kind: hit } : { from: frameAt(x), kind: "select" };
    if (!hit) {
      sel = null;
    }
    waveCv.setPointerCapture(e.pointerId);
    waveCv.focus();
    syncTools();
    draw();
  });
  waveCv.addEventListener("pointermove", (e) => {
    const x = localX(e);
    if (!drag) {
      waveCv.style.cursor = hitMarker(x) ? "ew-resize" : "crosshair";
      return;
    }
    if (drag.kind === "select") {
      sel = { a: drag.from, b: frameAt(x) };
      syncTools();
      draw();
    } else {
      moveMarker(drag.kind, frameAt(x));
    }
  });
  const endDrag = () => {
    if (drag?.kind === "select" && sel && Math.abs(sel.a - sel.b) < 2) {
      sel = null;
    }
    const moved = drag !== null && drag.kind !== "select";
    drag = null;
    if (moved) {
      buildInspector();
    }
    syncTools();
    draw();
  };
  waveCv.addEventListener("pointerup", endDrag);
  waveCv.addEventListener("pointercancel", endDrag);

  const selRange = (): { a: number; b: number } | null =>
    sel && Math.abs(sel.a - sel.b) >= 2
      ? { a: Math.min(sel.a, sel.b), b: Math.max(sel.a, sel.b) }
      : null;

  function syncTools(): void {
    const r = selRange();
    trimBtn.disabled = r === null;
    clearBtn.disabled = r === null;
    const hint = q("#sHint");
    hint.textContent = r
      ? `Selected ${(r.b - r.a).toLocaleString("en-US")} frames (${((r.b - r.a) / sample().rate).toFixed(3)} s).`
      : "Drag to select a part. Drag the green and purple loop markers.";
  }

  trimBtn.addEventListener("click", () => {
    const r = selRange();
    if (!r) {
      return;
    }
    edit((d) => trimTo(d, r.a, r.b), "trim");
    sel = null;
    rebuild();
  });
  clearBtn.addEventListener("click", () => {
    sel = null;
    syncTools();
    draw();
  });

  /* ----- playing ----- */
  const startNote = (n: number): number => {
    const ch = previewSampleNote(doc(), n);
    playing.note = n;
    playing.since = performance.now();
    playing.until = Number.POSITIVE_INFINITY;
    return ch;
  };
  const stopNote = (n: number): void => {
    const ch = heldNotes.get(n);
    if (ch !== undefined) {
      engine.noteOff(ch);
      heldNotes.delete(n);
    }
    if (playing.note === n) {
      playing.until = performance.now() + 150;
    }
  };

  function noteDown(n: number): void {
    heldNotes.set(n, startNote(n));
    kb.piano.light(n, hex, true);
    fire(engine.unlock());
  }
  function noteUp(n: number): void {
    stopNote(n);
    kb.piano.release(n);
  }

  let playTimer: ReturnType<typeof setTimeout> | undefined;
  function play(): void {
    const s = sample();
    const n = s.baseNote;
    noteUp(n);
    noteDown(n);
    clearTimeout(playTimer);
    const seconds = Math.min(
      4,
      Math.max(0.3, s.loop ? 1.5 : framesOf(s) / s.rate)
    );
    playTimer = setTimeout(() => noteUp(n), seconds * 1000);
  }

  /* ----- keyboard ----- */
  const kb = createKeyboard({
    canvas: q<HTMLCanvasElement>("#sKeys"),
    color: () => hex,
    noteDown: (n) => noteDown(n),
    noteUp: (n) => noteUp(n),
    octaveLabel: q("#sOct"),
    owns: (previewId) => previewId.startsWith("sample-preview:"),
  });

  /* ----- the inspector ----- */
  const chipOf = () => project.project.chip;

  function pitchGroup(): HTMLElement {
    const s = sample();
    const g = group("Pitch", { key: "sample-pitch" });
    const label = note(g.body, "");
    const showNote = () => {
      const d = sample();
      label.textContent = `Plays at ${noteName(d.baseNote)}${d.finetune === 0 ? "" : ` ${d.finetune > 0 ? "+" : ""}${d.finetune} cents`} when the song asks for that note.`;
    };
    showNote();
    const base = rangeField(g.body, {
      label: "Base note",
      max: 108,
      min: 12,
      onInput: (v) => {
        edit((d) => {
          d.baseNote = Math.round(v);
        }, "base");
        showNote();
      },
      step: 1,
      title: "The note the sample sounds like when it plays unchanged",
      value: s.baseNote,
    });
    const fine = rangeField(g.body, {
      label: "Fine tune",
      max: 100,
      min: -100,
      onInput: (v) => {
        edit((d) => {
          d.finetune = Math.round(v);
        }, "fine");
        showNote();
      },
      step: 1,
      title:
        "Cents the sample sounds sharp (positive) or flat at its base note",
      value: s.finetune,
    });
    const detect = h("button", {
      class: "btn small",
      title: "Listen to the recording and set the base note and fine tune",
      type: "button",
    });
    detect.innerHTML = `${icon("search", 12)}<span>Detect pitch</span>`;
    detect.addEventListener("click", () => {
      const p = pitchOf(sample());
      if (!p) {
        app.toast(
          "No clear pitch found: noise and drums have none. Set the base note by hand."
        );
        return;
      }
      edit((d) => {
        d.baseNote = p.baseNote;
        d.finetune = p.finetune;
      }, "detect");
      base.set(p.baseNote);
      fine.set(p.finetune);
      showNote();
      app.toast(
        `Detected ${noteName(p.baseNote)} (${Math.round(p.hz * 10) / 10} Hz)`
      );
    });
    g.body.append(h("div", { class: "fld" }, detect));
    return g.el;
  }

  function levelGroup(): HTMLElement {
    const s = sample();
    const g = group("Level", { key: "sample-level" });
    rangeField(g.body, {
      label: "Volume",
      max: 1,
      min: 0,
      onInput: (v) =>
        edit((d) => {
          d.volume = v;
        }, "volume"),
      step: 0.01,
      value: s.volume,
    });
    const peak = peakLevel(s);
    note(
      g.body,
      `Peak ${peak <= 0 ? "silent" : `${(20 * Math.log10(peak)).toFixed(1)} dBFS`}.`
    );
    const norm = h("button", {
      class: "btn small",
      title: "Scale the audio to the loudest level it can hold",
      type: "button",
    });
    norm.innerHTML = `${icon("up", 12)}<span>Normalize</span>`;
    norm.addEventListener("click", () => {
      edit((d) => normalized(d), "normalize");
      rebuild();
    });
    g.body.append(h("div", { class: "fld" }, norm));
    return g.el;
  }

  function loopGroup(): HTMLElement {
    const s = sample();
    const g = group("Loop", { key: "sample-loop" });
    const total = framesOf(s);
    const fields: { set: (v: number) => void }[] = [];
    toggleField(g.body, {
      label: "Loop",
      onInput: (on) => {
        const r = selRange();
        edit((d) => {
          d.loop = on ? { end: r?.b ?? total, start: r?.a ?? 0 } : null;
        }, "loop-on");
        rebuildInspector();
      },
      value: s.loop !== null,
    });
    if (s.loop) {
      fields.push(
        rangeField(g.body, {
          label: "Loop start",
          max: Math.max(1, total - 2),
          min: 0,
          onInput: (v) => moveMarker("loopStart", Math.round(v)),
          step: 1,
          value: s.loop.start,
        }),
        rangeField(g.body, {
          label: "Loop end",
          max: total,
          min: 2,
          onInput: (v) => moveMarker("loopEnd", Math.round(v)),
          step: 1,
          value: s.loop.end,
        })
      );
      note(
        g.body,
        "Frames. The part between the markers repeats while a note is held."
      );
    } else {
      note(
        g.body,
        "Off: the sample plays once. Select a part first to loop just that part."
      );
    }
    return g.el;
  }

  function formatGroup(): HTMLElement {
    const s = sample();
    const g = group("Format", { key: "sample-format" });
    note(g.body, describeSample(s));
    selectField<string>(g.body, {
      label: "Bit depth",
      onInput: (v) => {
        edit((d) => withBits(d, v === "8" ? 8 : 16), "bits");
        rebuildInspector();
      },
      options: [
        { label: "8 bit (the Amiga)", value: "8" },
        { label: "16 bit", value: "16" },
      ],
      value: String(s.bits),
    });
    if (chipOf() === "amiga" && s.bits === 16) {
      note(g.body, "The Amiga plays an 8 bit copy of this sample.");
    }
    return g.el;
  }

  /** Who made the sound and under which license, for a sample that came from Freesound. */
  function sourceGroup(): HTMLElement[] {
    const src = sample().source;
    if (!src) {
      return [];
    }
    const g = group("Source", { key: "sample-source" });
    g.body.append(
      h(
        "p",
        { class: "src-line" },
        licenseBadge(src.license),
        " ",
        h(
          "a",
          {
            class: "linkish",
            href: src.url,
            rel: "noopener",
            target: "_blank",
          },
          src.name
        ),
        ` by ${src.author}, from Freesound.org`
      )
    );
    note(
      g.body,
      src.license === "CC BY"
        ? "Creative Commons Attribution: a game that uses this sound must credit it. The project zip and the game audio export list it in CREDITS.txt."
        : "Creative Commons 0: no credit needed."
    );
    return [g.el];
  }

  function buildInspector(): void {
    insp.replaceChildren();
    const inner = h("div", { class: "insp-in" });
    insp.append(inner);
    const g1 = group("Sample", { key: "sample-main" });
    textField(g1.body, {
      label: "Name",
      onInput: (v) =>
        edit((d) => {
          d.name = v;
        }, "name"),
      value: sample().name,
    });
    inner.append(
      g1.el,
      ...sourceGroup(),
      pitchGroup(),
      levelGroup(),
      loopGroup(),
      formatGroup()
    );
    inner.append(docActions(doc, "Delete sample"));
  }
  const rebuildInspector = buildInspector;

  /* ----- the instruments that play it ----- */
  function users(): Doc[] {
    return project
      .list("instrument")
      .filter((d) => (d.value as Instrument).sample?.userSample === id);
  }

  function buildUsed(): void {
    const el = q("#sUsed");
    const list = users();
    const body = h("div", { class: "card-b" });
    if (list.length === 0) {
      body.append(
        h(
          "p",
          { class: "muted" },
          "No instrument plays this sample yet. Make one, then write notes for it in a song: the sample sounds at its base note when the song plays that note."
        )
      );
    } else {
      const ul = h("ul", { class: "used-by" });
      for (const d of list) {
        ul.append(
          h(
            "li",
            {},
            h(
              "a",
              {
                class: "linkish",
                href: `#/instrument/${encodeURIComponent(d.id)}`,
              },
              (d.value as Instrument).name || d.id
            )
          )
        );
      }
      body.append(h("p", { class: "muted" }, "Played by:"), ul);
    }
    el.replaceChildren(
      h("div", { class: "card-h" }, h("h3", { class: "pxh" }, "Instruments")),
      body
    );
  }

  async function makeInstrument(): Promise<void> {
    const created = await createSampleInstrument(id, sample());
    app.toast(`Made instrument ${created.id}`, "Open", () =>
      app.navigate(`#/instrument/${encodeURIComponent(created.id)}`)
    );
    buildUsed();
  }

  /* ----- header and rebuilds ----- */
  function syncHeader(): void {
    if (document.activeElement !== nameIn) {
      nameIn.value = sample().name;
    }
    q("#sInfo").textContent = describeSample(sample());
    q("#sLic").replaceChildren(
      ...(sample().source
        ? [licenseBadge(sample().source?.license ?? "CC0")]
        : [])
    );
    host.style.setProperty("--kc", hex);
    ctx.setChip(chipOf());
  }

  function rebuild(): void {
    syncHeader();
    syncTools();
    buildInspector();
    buildUsed();
    showIssues(q("#sIssues"), doc().issues);
    draw();
  }

  /* ----- wiring ----- */
  q("#sPlay").addEventListener("click", play);
  q("#sMake").addEventListener("click", () => fire(makeInstrument()));
  q("#sOctDn").addEventListener("click", () => kb.shift(-1));
  q("#sOctUp").addEventListener("click", () => kb.shift(1));
  bindName(nameIn, (name) =>
    edit((d) => {
      d.name = name;
    }, "name")
  );

  const unsub = project.subscribe((e) => {
    if (e.type === "list") {
      if (!project.get("sample", id)) {
        app.navigate("#/pads");
        return;
      }
      buildUsed();
      return;
    }
    if (e.type !== "doc" || e.cause === "saved") {
      return;
    }
    if (e.path === doc()?.path) {
      syncHeader();
      showIssues(q("#sIssues"), doc().issues);
      draw();
      if (e.cause !== "edit") {
        sel = null;
        rebuild();
      }
    }
  });

  /* ----- visuals ----- */
  const offVisual = addVisual((f) => {
    kb.frame(f);
    if (playing.note >= 0) {
      draw();
      drawPlayhead(performance.now());
      if (performance.now() > playing.until) {
        playing.note = -1;
        draw();
      }
    }
  });

  rebuild();
  kb.piano.draw();
  ctx.cleanup(() => {
    offVisual();
    unsub();
    clearTimeout(playTimer);
    wave.dispose();
    kb.dispose();
    for (const n of [...heldNotes.keys()]) {
      stopNote(n);
    }
    releaseNote();
  });

  const commands = (): Command[] => [
    {
      group: "Sample",
      icon: "play",
      id: "sample:play",
      keys: "Space",
      run: play,
      title: "Play the sample",
    },
    {
      group: "Sample",
      icon: "plus",
      id: "sample:make",
      run: () => fire(makeInstrument()),
      title: "Make an instrument from this sample",
    },
  ];

  return {
    chip: () => chipOf(),
    commands,
    doc: () => doc(),
    onKey: kb.onKey,
    play,
    stop: stopEverything,
  };
}
