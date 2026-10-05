/* The analysis view: the numbers an agent (or an ear) wants about a sound, as cards, and the three analysis images
   drawn live on canvas. Everything is rendered and measured in the render worker; the numbers count up when they land. */
import type { ViewHooks } from "../app.ts";
import { app } from "../app.ts";
import { categoryColor, chipTheme, KIND_HEX } from "../lib/chips.ts";
import type { Instrument, Sfx, Song } from "../lib/contract.ts";
import type { Analysis, PixelImage } from "../lib/core.ts";
import {
  choose,
  debounce,
  fire,
  formatTime,
  h,
  reducedMotion,
} from "../lib/dom.ts";
import { playDoc, stopEverything } from "../playback.ts";
import { analyzeAsync } from "../render-service.ts";
import type { ViewCtx } from "../shell.ts";
import { type Doc, project } from "../state/docs.ts";
import { group } from "../ui/fields.ts";
import { icon } from "../ui/icons.ts";
import { surface } from "../visuals/canvas.ts";
import { addVisual } from "../visuals/loop.ts";
import {
  drawSpectrogram,
  drawWaveform,
  makeSpectrogram,
} from "../visuals/waveform.ts";
import type { AnalysisBundle, Source } from "../workers/render.ts";

interface Card {
  bar?: number;
  label: string;
  sub?: string;
  text: (v: number) => string;
  tone?: "ok" | "warn" | "bad";
  value: number | null;
}

const db = (v: number) => (v <= -119 ? "-inf dB" : `${v.toFixed(1)} dB`);

function sourceOf(doc: Doc): Source {
  if (doc.kind === "sfx") {
    return { sfx: doc.value as Sfx, type: "sfx" };
  }
  if (doc.kind === "song") {
    return {
      instruments: project.instruments(),
      song: doc.value as Song,
      type: "song",
    };
  }
  return { inst: doc.value as Instrument, note: 60, type: "note" };
}

export function mountAnalysis(ctx: ViewCtx, ref: string): ViewHooks {
  const { host, insp } = ctx;
  const doc = project.find(ref);
  if (!doc) {
    host.innerHTML = `<div class="empty-state"><h2 class="pxh">Nothing to analyse</h2><p class="muted">There is no sound called <b></b>. Pick a sound effect or song in the project tree.</p><a class="btn" href="#/pads">Back to the pads</a></div>`;
    (host.querySelector("b") as HTMLElement).textContent = ref;
    return {};
  }
  const file = `${doc.kind}/${doc.id}`;
  const color = choose(
    [
      [doc.kind === "sfx", categoryColor((doc.value as Sfx).category)],
      [doc.kind === "instrument", KIND_HEX[(doc.value as Instrument).kind]],
    ],
    "#7d97dc"
  );
  let bundle: AnalysisBundle | null = null;
  let token = 0;
  let playStart = -1;

  host.innerHTML = `
    <div class="an-view">
      <div class="ed-head">
        <div class="ed-title"><span class="big-ico" id="aIcon"></span><div><h1 class="vh" id="aName"></h1><small class="muted mono" id="aFile"></small></div></div>
        <div class="ed-actions">
          <button class="btn primary big" id="aPlay">${icon("play", 16)}<span>Play</span></button>
          <button class="btn" id="aCopy" title="Copy the analysis as JSON, for an agent">${icon("copy", 14)}<span>Copy as JSON</span></button>
          <button class="btn" id="aRerun">${icon("refresh", 14)}<span>Measure again</span></button>
          <a class="btn" id="aOpen">${icon("right", 14)}<span>Open editor</span></a>
        </div>
      </div>
      <div class="clipbar" id="aClip" hidden role="alert"></div>
      <div class="loading" id="aLoad"><span class="spin"></span><span>Rendering and measuring</span></div>
      <div class="stat-grid" id="aStats"></div>
      <div class="an-imgs" id="aImgs"></div>
    </div>`;
  const q = <T extends HTMLElement>(sel: string) =>
    host.querySelector(sel) as T;
  const icoEl = q("#aIcon");
  icoEl.innerHTML = icon(
    choose(
      [
        [doc.kind === "sfx", (doc.value as Sfx).category],
        [doc.kind === "instrument", (doc.value as Instrument).kind],
      ],
      "song"
    ),
    22
  );
  icoEl.style.color = color;
  q("#aName").textContent = (doc.value as { name: string }).name;
  q("#aFile").textContent =
    `${file}  ${doc.kind === "instrument" ? "(note C4)" : ""}`;
  (q("#aOpen") as HTMLAnchorElement).href = `#/${doc.kind}/${doc.id}`;
  if (doc.kind === "song") {
    ctx.setChip((doc.value as Song).chip);
  } else if (doc.kind === "sfx") {
    ctx.setChip((doc.value as Sfx).chip);
  }
  const play = () => {
    playStart = performance.now();
    playDoc(doc);
  };
  q("#aPlay").addEventListener("click", play);
  q("#aRerun").addEventListener("click", () => fire(measure()));

  /* ----- cards ----- */
  function cardsOf(a: Analysis): Card[] {
    const clipped = a.clipped.frames > 0;
    const cards: Card[] = [
      {
        bar: Math.min(1, Math.max(0, (a.peakDb + 60) / 60)),
        label: "Peak",
        text: db,
        tone: choose(
          [
            [clipped || a.peakDb >= -0.1, "bad" as const],
            [a.peakDb > -1, "warn" as const],
          ],
          "ok" as const
        ),
        value: a.peakDb,
      },
      {
        bar: Math.min(1, Math.max(0, (a.rmsDb + 60) / 60)),
        label: "RMS",
        text: db,
        value: a.rmsDb,
      },
      {
        bar: Math.min(1, Math.max(0, (a.lufs + 60) / 60)),
        label: "Loudness",
        sub: "K-weighted, integrated",
        text: (v) => `${v.toFixed(1)} LUFS`,
        value: a.lufs,
      },
      {
        label: "Duration",
        sub: `${a.frames.toLocaleString()} frames at ${a.sampleRate} Hz`,
        text: (v) => `${v.toFixed(2)} s`,
        value: a.duration,
      },
      {
        label: "Crest factor",
        sub: "peak minus RMS",
        text: db,
        value: a.crestDb,
      },
      {
        label: "DC offset",
        text: (v) => v.toFixed(4),
        tone: Math.abs(a.dcOffset) > 0.02 ? "warn" : "ok",
        value: a.dcOffset,
      },
      {
        label: "Silence",
        sub: `${(a.trailingSilence * 1000).toFixed(0)} ms at the end`,
        text: (v) => `${(v * 1000).toFixed(0)} ms in`,
        value: a.leadingSilence,
      },
      {
        label: "Centroid",
        sub: "spectral brightness",
        text: (v) => `${Math.round(v)} Hz`,
        value: a.spectrum.centroidHz,
      },
    ];
    if (a.loop) {
      const good = a.loop.seamDiffDb < -30;
      cards.splice(4, 0, {
        label: "Loop seam",
        sub: `${a.loop.start.toFixed(2)} s to ${a.loop.end.toFixed(2)} s`,
        text: db,
        tone: choose(
          [
            [good, "ok" as const],
            [a.loop.seamDiffDb < -15, "warn" as const],
          ],
          "bad" as const
        ),
        value: a.loop.seamDiffDb,
      });
    }
    cards.splice(a.loop ? 5 : 4, 0, {
      label: "Pitch",
      text: (v) =>
        `${a.pitch.medianNote ?? ""} ${Math.round(v * 10) / 10} Hz`.trim(),
      value: a.pitch.medianHz,
      ...(a.pitch.medianHz === null
        ? { sub: "no steady pitch" }
        : { sub: "median" }),
    });
    if (a.dutyCycle !== null) {
      cards.push({
        label: "Pulse width",
        text: (v) => `${Math.round(v * 1000) / 10}%`,
        value: a.dutyCycle,
      });
    }
    return cards;
  }

  function countUp(el: HTMLElement, card: Card): void {
    if (card.value === null) {
      el.textContent = "none";
      return;
    }
    const target = card.value;
    if (reducedMotion()) {
      el.textContent = card.text(target);
      return;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 520);
      const e = 1 - (1 - t) ** 3;
      el.textContent = card.text(target * e + (t < 1 ? 0 : 0));
      if (t < 1 && el.isConnected) {
        requestAnimationFrame(step);
      } else {
        el.textContent = card.text(target);
      }
    };
    requestAnimationFrame(step);
  }

  function renderStats(a: Analysis): void {
    const grid = q("#aStats");
    grid.replaceChildren();
    for (const c of cardsOf(a)) {
      const el = h("div", { class: `stat${c.tone ? ` ${c.tone}` : ""}` });
      el.innerHTML = `<small class="pxh"></small><b class="mono val"></b><span class="sub"></span>${c.bar === undefined ? "" : `<i class="meter"><u style="width:0%"></u></i>`}`;
      (el.querySelector("small") as HTMLElement).textContent = c.label;
      (el.querySelector(".sub") as HTMLElement).textContent = c.sub ?? "";
      grid.append(el);
      countUp(el.querySelector(".val") as HTMLElement, c);
      const bar = el.querySelector("u") as HTMLElement | null;
      const fill = c.bar;
      if (bar && fill !== undefined) {
        requestAnimationFrame(() => {
          bar.style.width = `${Math.round(fill * 100)}%`;
        });
      }
    }
    const { bands } = a.spectrum;
    const sp = h("div", { class: "stat wide" });
    sp.innerHTML = `<small class="pxh">Spectrum balance</small><div class="bands"></div>`;
    const box = sp.querySelector(".bands") as HTMLElement;
    for (const [label, v, range] of [
      ["Low", bands.lowDb, "20 to 250 Hz"],
      ["Mid", bands.midDb, "250 Hz to 4 kHz"],
      ["High", bands.highDb, "4 kHz up"],
    ] as const) {
      const row = h("div", { class: "band" });
      const pct = Math.max(0, Math.min(1, (v + 90) / 90));
      row.innerHTML = `<span>${label}</span><i class="meter"><u style="width:0%"></u></i><b class="mono">${db(v)}</b><small>${range}</small>`;
      box.append(row);
      const u = row.querySelector("u") as HTMLElement;
      requestAnimationFrame(() => {
        u.style.width = `${Math.round(pct * 100)}%`;
      });
    }
    grid.append(sp);
    const clip = q("#aClip");
    if (a.clipped.frames > 0) {
      clip.hidden = false;
      clip.innerHTML = `${icon("warn", 16)}<span></span>`;
      (clip.querySelector("span") as HTMLElement).textContent =
        `Clipping: ${a.clipped.frames.toLocaleString()} frames reach full scale, the first at ${formatTime(a.clipped.first ?? 0)}. Lower the volume or turn the limiter on.`;
    } else {
      clip.hidden = true;
    }
  }

  /* ----- images ----- */
  const frames: {
    surf: ReturnType<typeof surface> | null;
    wrap: HTMLElement;
    ph: HTMLCanvasElement;
    dur: number;
  }[] = [];
  function putImage(
    title: string,
    img: PixelImage | null,
    draw?: (s: ReturnType<typeof surface>) => void,
    dur = 0
  ): void {
    const wrap = h("div", { class: "an-img" });
    wrap.append(h("h3", { class: "pxh" }, title));
    const frame = h("div", { class: "an-frame" });
    wrap.append(frame);
    const ph = h("canvas", { class: "an-ph" }) as HTMLCanvasElement;
    let surf: ReturnType<typeof surface> | null = null;
    if (img) {
      const cv = h("canvas", {
        "aria-label": `${title} image`,
        class: "an-cv",
        height: img.height,
        width: img.width,
      }) as HTMLCanvasElement;
      const g = cv.getContext("2d");
      if (g && typeof ImageData !== "undefined") {
        g.putImageData(
          new ImageData(
            new Uint8ClampedArray(
              img.data.buffer as ArrayBuffer,
              img.data.byteOffset,
              img.data.byteLength
            ),
            img.width,
            img.height
          ),
          0,
          0
        );
      }
      frame.append(cv);
    } else if (draw) {
      const cv = h("canvas", {
        "aria-label": `${title} drawing`,
        class: "an-cv self",
      }) as HTMLCanvasElement;
      frame.append(cv);
      requestAnimationFrame(() => {
        surf = surface(cv);
        draw(surf);
      });
    }
    frame.append(ph);
    q("#aImgs").append(wrap);
    frames.push({ dur, ph, surf, wrap: frame });
  }

  function renderImages(b: AnalysisBundle): void {
    for (const f of frames) {
      f.surf?.dispose();
    }
    frames.length = 0;
    q("#aImgs").replaceChildren();
    const dur = b.analysis.duration;
    const r = b.result;
    putImage(
      "Waveform",
      b.images.waveform,
      r ? (s) => drawWaveform(s, r, { clip: true, color }) : undefined,
      dur
    );
    putImage(
      "Spectrogram",
      b.images.spectrogram,
      r
        ? (s) =>
            drawSpectrogram(
              s,
              makeSpectrogram(
                r,
                480,
                160,
                chipTheme(
                  doc && doc.kind !== "instrument"
                    ? (doc.value as Sfx | Song).chip
                    : "nes"
                ).ramp
              )
            )
        : undefined,
      dur
    );
    if (b.images.scopes) {
      putImage("Channel scopes", b.images.scopes, undefined, dur);
    }
  }

  /* ----- measure ----- */
  async function measure(): Promise<void> {
    token += 1;
    const mine = token;
    q("#aLoad").hidden = false;
    try {
      const res = await analyzeAsync(
        sourceOf(doc as Doc),
        file,
        1100,
        project.project.sampleRate
      );
      if (mine !== token) {
        return;
      }
      bundle = res;
      q("#aLoad").hidden = true;
      renderStats(res.analysis);
      renderImages(res);
      buildInspector();
    } catch (err) {
      if (mine === token) {
        q("#aLoad").innerHTML = "";
        q("#aLoad").append(
          h(
            "span",
            { class: "bad" },
            `Could not measure this sound: ${(err as Error).message}`
          )
        );
      }
    }
  }
  const remeasure = debounce(() => fire(measure()), 500);

  /* ----- inspector ----- */
  async function copyJson(): Promise<void> {
    if (!bundle) {
      app.toast("Still measuring");
      return;
    }
    const text = JSON.stringify(bundle.analysis, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      app.toast("Copied the analysis as JSON");
    } catch {
      const ta = h("textarea", {
        style: "position:fixed;left:-999px",
      }) as HTMLTextAreaElement;
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      app.toast("Copied the analysis as JSON");
    }
  }
  q("#aCopy").addEventListener("click", () => fire(copyJson()));

  function buildInspector(): void {
    insp.replaceChildren();
    const inner = h("div", { class: "insp-in" });
    insp.append(inner);
    const title = h("div", { class: "insp-title" });
    title.innerHTML = `${icon("chart", 16)}<span class="nm">Analysis JSON</span>`;
    inner.append(title);
    inner.append(
      h(
        "div",
        { class: "hint" },
        "This is the same object `bleepkit analyze` prints, so an agent can read what you see."
      )
    );
    inner.append(
      h(
        "div",
        { class: "hint btn-row" },
        h(
          "button",
          { class: "btn small primary", onclick: () => fire(copyJson()) },
          "Copy as JSON"
        )
      )
    );
    const g = group("Values", { key: "an-json" });
    const pre = h("pre", { class: "json" });
    if (bundle) {
      const a = {
        ...bundle.analysis,
        envelope: `${bundle.analysis.envelope.length} points`,
        pitch: {
          ...bundle.analysis.pitch,
          track: `${bundle.analysis.pitch.track.length} points`,
        },
      };
      pre.textContent = JSON.stringify(a, null, 2);
    } else {
      pre.textContent = "Measuring...";
    }
    g.body.append(pre);
    inner.append(g.el);
  }

  /* ----- playhead over the images ----- */
  const off = addVisual(() => {
    if (playStart < 0) {
      return;
    }
    const t = (performance.now() - playStart) / 1000;
    for (const fr of frames) {
      const cv = fr.ph;
      const w = fr.wrap.clientWidth;
      const hh = fr.wrap.clientHeight;
      if (cv.width !== w || cv.height !== hh) {
        cv.width = w;
        cv.height = hh;
      }
      const g = cv.getContext("2d");
      if (!g || fr.dur <= 0) {
        continue;
      }
      g.clearRect(0, 0, w, hh);
      if (t <= fr.dur + 0.1) {
        // the image has margins; the plot spans roughly 7% to 98% of the width for the built-in images
        const x0 = w * 0.065;
        const x1 = w * 0.985;
        const x = x0 + (x1 - x0) * Math.min(1, t / fr.dur);
        g.fillStyle = "rgba(236,231,218,0.9)";
        g.fillRect(Math.floor(x), 0, 2, hh);
        g.fillStyle = "rgba(236,231,218,0.12)";
        g.fillRect(Math.floor(x) - 14, 0, 14, hh);
      }
    }
    if (t > Math.max(...frames.map((x) => x.dur), 0) + 0.2) {
      playStart = -1;
      for (const fr of frames) {
        fr.ph.getContext("2d")?.clearRect(0, 0, fr.ph.width, fr.ph.height);
      }
    }
  });

  const unsub = project.subscribe((e) => {
    if (e.type === "doc" && e.path === doc.path && e.cause !== "saved") {
      remeasure();
    }
  });
  buildInspector();
  fire(measure());
  ctx.cleanup(() => {
    off();
    unsub();
    remeasure.cancel();
    token += 1;
    for (const f of frames) {
      f.surf?.dispose();
    }
  });

  return {
    chip: () =>
      doc.kind === "instrument"
        ? ((doc.value as Instrument).chip ?? project.project.chip)
        : (doc.value as Sfx | Song).chip,
    doc: () => doc,
    play,
    stop: stopEverything,
  };
}
