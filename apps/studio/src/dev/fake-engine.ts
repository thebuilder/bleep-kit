/* A stand-in for the AudioWorklet engine (section 10): the same EngineNodeLike surface, built on the main thread.
   Sounds are rendered offline with renderSfx / renderSong / renderInstrumentNote (the real ones when core has them, the
   rough stubs otherwise) and played through AudioBufferSourceNodes. A setInterval posts clock, events and scope data,
   so every view can be built and tested without a worklet. `?engine=fake` selects it, and the DOM tests use it. */

import type { EngineNodeLike, ScopeReaderLike } from "../engine/types.ts";
import type {
  EngineEvent,
  FromWorklet,
  Instrument,
  RenderResult,
  Sfx,
  Song,
  ToWorklet,
} from "../lib/contract.ts";
import { renderInstrumentNote, renderSfx, renderSong } from "../lib/core.ts";

interface Voice {
  channel: number;
  end: number;
  gain: GainNode | null;
  handle: number;
  held: boolean;
  mono: Float32Array;
  source: AudioBufferSourceNode | null;
  start: number;
}

const TICK_MS = 25;

export function createFakeEngine(ctx: BaseAudioContext | null): EngineNodeLike {
  const sr = ctx?.sampleRate ?? 48_000;
  const handlers = new Set<(m: FromWorklet) => void>();
  const t0 = typeof performance === "undefined" ? 0 : performance.now();
  const sfxDocs = new Map<string, Sfx>();
  const instruments = new Map<string, Instrument>();
  const renderCache = new Map<string, RenderResult>();
  let song: Song | null = null;
  let songInstruments: Record<string, Instrument> = {};
  let master = 0.8;
  const out = ctx ? ctx.createGain() : null;
  out?.connect(ctx?.destination as AudioNode);
  if (out) {
    out.gain.value = master;
  }

  const now = (): number => {
    if (ctx) {
      return Math.floor(ctx.currentTime * sr);
    }
    return Math.floor(((performance.now() - t0) / 1000) * sr);
  };

  const emit = (m: FromWorklet) => {
    for (const h of handlers) {
      h(m);
    }
  };

  /* ----- voices (sfx and keyboard notes), kept for the scopes ----- */
  let voices: Voice[] = [];
  const bufferOf = (r: RenderResult): AudioBuffer | null => {
    if (!ctx) {
      return null;
    }
    const b = ctx.createBuffer(2, Math.max(1, r.frames), r.sampleRate);
    b.copyToChannel(r.channels[0] as Float32Array<ArrayBuffer>, 0);
    b.copyToChannel(
      (r.channels[1] ?? r.channels[0]) as Float32Array<ArrayBuffer>,
      1
    );
    return b;
  };
  const monoOf = (r: RenderResult): Float32Array => {
    const m = new Float32Array(r.frames);
    const a = r.channels[0];
    const b = r.channels[1] ?? a;
    for (let i = 0; i < r.frames; i++) {
      m[i] = ((a?.[i] ?? 0) + (b?.[i] ?? 0)) / 2;
    }
    return m;
  };
  const play = (
    r: RenderResult,
    opts: {
      velocity?: number;
      pan?: number;
      channel: number;
      handle: number;
      held?: boolean;
    }
  ): Voice => {
    const start = now();
    const voice: Voice = {
      channel: opts.channel,
      end: start + r.frames,
      gain: null,
      handle: opts.handle,
      held: !!opts.held,
      mono: monoOf(r),
      source: null,
      start,
    };
    if (ctx && out) {
      const src = ctx.createBufferSource();
      src.buffer = bufferOf(r);
      const g = ctx.createGain();
      g.gain.value = opts.velocity ?? 1;
      src.connect(g);
      g.connect(out);
      src.start();
      voice.source = src;
      voice.gain = g;
    }
    voices.push(voice);
    voices = voices.filter((v) => v.end > start - sr);
    return voice;
  };

  const cacheKey = (kind: string, doc: unknown, extra = "") =>
    `${kind}:${extra}:${JSON.stringify(doc)}`;
  const sfxResult = (sfx: Sfx): RenderResult => {
    const k = cacheKey("sfx", sfx, String(sr));
    let r = renderCache.get(k);
    if (!r) {
      r = renderSfx(sfx, { sampleRate: sr });
      renderCache.set(k, r);
      if (renderCache.size > 80) {
        renderCache.delete(renderCache.keys().next().value as string);
      }
    }
    return r;
  };

  /* ----- the song ----- */
  let songRes: RenderResult | null = null;
  let songSource: AudioBufferSourceNode | null = null;
  let playing = false;
  /** Render-domain frame at engine frame `anchorEngine`. */
  let anchorRender = 0;
  let anchorEngine = 0;
  let lastEmitRender = -1;
  let looping = true;

  const wrapRender = (f: number): number => {
    if (!songRes) {
      return 0;
    }
    const ls = songRes.loopStart;
    const le = songRes.loopEnd;
    if (looping && ls !== undefined && le !== undefined && f >= le) {
      return ls + ((f - le) % Math.max(1, le - ls));
    }
    return f;
  };
  const renderFrameNow = (): number =>
    wrapRender(anchorRender + (now() - anchorEngine));
  const renderFrameAt = (engineFrame: number): number =>
    wrapRender(Math.max(0, anchorRender + (engineFrame - anchorEngine)));

  const stopSource = () => {
    try {
      songSource?.stop();
    } catch {
      // already stopped
    }
    songSource?.disconnect();
    songSource = null;
  };
  const startSong = (order?: number, row?: number, loop?: boolean) => {
    if (!song) {
      return;
    }
    const key = cacheKey("song", { i: songInstruments, song }, String(sr));
    let r = renderCache.get(key);
    if (!r) {
      r = renderSong(song, songInstruments, {
        sampleRate: sr,
        stems: true,
        tail: 0.5,
      });
      renderCache.set(key, r);
    }
    songRes = r;
    looping = loop ?? true;
    let startFrame = 0;
    if (order !== undefined || row !== undefined) {
      const hit = r.events.find(
        (e) =>
          e.type === "row" && e.order === (order ?? 0) && e.row === (row ?? 0)
      );
      startFrame = hit?.frame ?? 0;
    } else if (!playing && anchorRender > 0 && anchorRender < r.frames) {
      startFrame = anchorRender; // resume from a pause
    }
    stopSource();
    if (ctx && out) {
      const src = ctx.createBufferSource();
      src.buffer = bufferOf(r);
      if (looping && r.loopStart !== undefined && r.loopEnd !== undefined) {
        src.loop = true;
        src.loopStart = r.loopStart / r.sampleRate;
        src.loopEnd = r.loopEnd / r.sampleRate;
      }
      src.connect(out);
      src.start(0, startFrame / r.sampleRate);
      songSource = src;
    }
    anchorRender = startFrame;
    anchorEngine = now();
    lastEmitRender = startFrame - 1;
    playing = true;
  };

  /* ----- scopes ----- */
  const bufs = new Map<string, Float32Array>();
  const buf = (key: string, n: number): Float32Array => {
    const k = `${key}:${n}`;
    let b = bufs.get(k);
    if (!b) {
      b = new Float32Array(n);
      bufs.set(k, b);
    }
    return b;
  };
  const scopes: ScopeReaderLike = {
    at(channel, frame, frames) {
      const o = buf(String(channel), frames);
      o.fill(0);
      if (channel < 0) {
        if (playing && songRes) {
          const base = renderFrameAt(frame);
          const L =
            songRes.channels[channel === -1 ? 0 : 1] ?? songRes.channels[0];
          for (let i = 0; i < frames; i++) {
            o[i] = L?.[wrapRender(base + i)] ?? 0;
          }
        }
        for (const v of voices) {
          for (let i = 0; i < frames; i++) {
            const k = frame + i - v.start;
            if (k >= 0 && k < v.mono.length) {
              o[i] = (o[i] ?? 0) + (v.mono[k] ?? 0);
            }
          }
        }
        return o;
      }
      if (playing && songRes?.stems?.[channel]) {
        const stem = songRes.stems[channel];
        const base = renderFrameAt(frame);
        for (let i = 0; i < frames; i++) {
          o[i] = stem[wrapRender(base + i)] ?? 0;
        }
      }
      for (const v of voices) {
        if (v.channel !== channel) {
          continue;
        }
        for (let i = 0; i < frames; i++) {
          const k = frame + i - v.start;
          if (k >= 0 && k < v.mono.length) {
            o[i] = (o[i] ?? 0) + (v.mono[k] ?? 0);
          }
        }
      }
      return o;
    },
    latest(channel, frames) {
      return scopes.at(channel, now() - frames, frames);
    },
  };

  /* ----- the clock: events and position every tick ----- */
  let lastClock = 0;
  const timer = setInterval(() => {
    const frame = now();
    const events: EngineEvent[] = [];
    let pos: {
      order: number;
      row: number;
      tick: number;
      pulse: number;
    } | null = null;
    if (playing && songRes) {
      const cur = renderFrameNow();
      const from = lastEmitRender;
      const wrapped = cur < from;
      const inWindow = (f: number) =>
        wrapped ? f > from || f <= cur : f > from && f <= cur;
      for (const e of songRes.events) {
        if (inWindow(e.frame)) {
          if (e.type === "end") {
            continue;
          }
          events.push({ ...e, frame: frame + (e.frame - cur) });
        }
      }
      if (wrapped) {
        events.push({
          channel: -1,
          channelId: "",
          frame,
          hz: 0,
          id: "",
          note: 0,
          order: -1,
          row: -1,
          type: "loop",
          velocity: 0,
        });
      }
      lastEmitRender = cur;
      let lastRow: EngineEvent | undefined;
      for (const e of songRes.events) {
        if (e.type === "row" && e.frame <= cur) {
          lastRow = e;
        } else if (e.frame > cur) {
          break;
        }
      }
      if (lastRow) {
        pos = {
          order: lastRow.order,
          pulse: Math.round(((cur / sr) * ((song?.tempo ?? 120) * 96)) / 60),
          row: lastRow.row,
          tick: 0,
        };
      }
      const noLoop = songRes.loopStart === undefined || !looping;
      if (noLoop && cur >= songRes.frames - 1) {
        playing = false;
        events.push({
          channel: -1,
          channelId: "",
          frame,
          hz: 0,
          id: "",
          note: 0,
          order: -1,
          row: -1,
          type: "end",
          velocity: 0,
        });
        emit({ type: "ended" });
      }
    }
    if (events.length) {
      emit({
        clockFrame: frame,
        clockTime: ctx?.currentTime ?? 0,
        events,
        type: "events",
      });
    }
    if (frame - lastClock > sr / 20) {
      lastClock = frame;
      emit({
        frame,
        playing,
        position: pos,
        time: ctx?.currentTime ?? 0,
        type: "clock",
      });
    }
  }, TICK_MS);

  const onEvent = (e: Partial<EngineEvent> & { type: EngineEvent["type"] }) => {
    const frame = now();
    emit({
      clockFrame: frame,
      clockTime: ctx?.currentTime ?? 0,
      events: [
        {
          channel: -1,
          channelId: "",
          frame,
          hz: 0,
          id: "",
          note: 0,
          order: -1,
          row: -1,
          velocity: 0,
          ...e,
        },
      ],
      type: "events",
    });
  };

  return {
    dispose() {
      clearInterval(timer);
      stopSource();
      handlers.clear();
    },
    node: out,
    nowFrame: now,
    on(h) {
      handlers.add(h);
      emit({ sampleRate: sr, type: "ready" });
      return () => handlers.delete(h);
    },
    scopes,
    send(msg: ToWorklet) {
      switch (msg.type) {
        case "loadSong":
          song = msg.song;
          songInstruments = msg.instruments;
          break;
        case "unloadSong":
          stopSource();
          playing = false;
          song = null;
          songRes = null;
          break;
        case "loadSfx":
          sfxDocs.set(msg.id, msg.sfx);
          break;
        case "unloadSfx":
          sfxDocs.delete(msg.id);
          break;
        case "setInstrument":
          instruments.set(msg.id, msg.instrument);
          songInstruments = { ...songInstruments, [msg.id]: msg.instrument };
          break;
        case "play":
          startSong(msg.order, msg.row, msg.loop);
          break;
        case "stop":
          stopSource();
          playing = false;
          anchorRender = 0;
          for (const v of voices) {
            v.source?.stop();
          }
          voices = [];
          emit({
            frame: now(),
            playing: false,
            position: null,
            time: ctx?.currentTime ?? 0,
            type: "clock",
          });
          break;
        case "pause":
          anchorRender = renderFrameNow();
          stopSource();
          playing = false;
          break;
        case "seek":
          if (playing || songRes) {
            startSong(msg.order, msg.row, looping);
          }
          break;
        case "trigger": {
          const sfx = sfxDocs.get(msg.id);
          if (!sfx) {
            break;
          }
          const r = sfxResult(sfx);
          play(r, {
            channel: -1,
            handle: msg.handle,
            velocity: msg.velocity ?? 1,
          });
          onEvent({
            hz: sfx.frequency.start,
            id: msg.id,
            type: "trigger",
            velocity: msg.velocity ?? 1,
          });
          break;
        }
        case "release": {
          for (const v of voices) {
            if (v.handle === msg.handle && v.held) {
              v.gain?.gain.setTargetAtTime(0, ctx?.currentTime ?? 0, 0.03);
              v.held = false;
            }
          }
          break;
        }
        case "noteOn": {
          const id = msg.instrument ?? "";
          const inst = instruments.get(id) ?? songInstruments[id];
          if (!inst) {
            break;
          }
          const key = cacheKey("note", inst, `${msg.note}:${sr}`);
          let r = renderCache.get(key);
          if (!r) {
            r = renderInstrumentNote(inst, msg.note, {
              duration: 0.6,
              release: 0.4,
              sampleRate: sr,
            });
            renderCache.set(key, r);
          }
          for (const v of voices) {
            if (v.channel === msg.channel && v.held) {
              v.gain?.gain.setTargetAtTime(0, ctx?.currentTime ?? 0, 0.02);
              v.held = false;
            }
          }
          play(r, {
            channel: msg.channel,
            handle: 0,
            held: true,
            velocity: msg.velocity,
          });
          onEvent({
            channel: msg.channel,
            hz: 440 * 2 ** ((msg.note - 69) / 12),
            id,
            note: msg.note,
            type: "noteOn",
            velocity: msg.velocity,
          });
          break;
        }
        case "noteOff":
          for (const v of voices) {
            if (v.channel === msg.channel && v.held) {
              v.gain?.gain.setTargetAtTime(0, ctx?.currentTime ?? 0, 0.06);
              v.held = false;
            }
          }
          onEvent({ channel: msg.channel, type: "noteOff" });
          break;
        case "setMaster":
          if (msg.volume !== undefined) {
            master = msg.volume;
            if (out) {
              out.gain.value = master;
            }
          }
          break;
        default:
          break;
      }
    },
  };
}
