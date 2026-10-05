/* The realtime engine (sections 3 and 4.1). Everything that allocates is a load* or set* method; process() never
   allocates. Time inside process is split into segments at every tick and sequencer event, so notes start on the
   exact frame and results do not depend on the host's block size. */

import { CUSTOM } from "../chips/custom.ts";
import { CHIPS, chipChannels } from "../chips/index.ts";
import { ChipBus } from "../dsp/color.ts";
import { Echo } from "../dsp/echo.ts";
import { Limiter } from "../dsp/limiter.ts";
import { Reverb } from "../dsp/reverb.ts";
import { renderSidGroup } from "../dsp/sid.ts";
import { setSidFilter, sidFilterMode } from "../dsp/sid-filter.ts";
import type { Svf } from "../dsp/svf.ts";
import { newSvf, svfProcess, svfReset } from "../dsp/svf.ts";
import { noteToHz } from "../notes.ts";
import { deriveSeed } from "../prng.ts";
import { generateSample } from "../samples/index.ts";
import type {
  ChipChannel,
  ChipId,
  ChipProfile,
  EngineEvent,
  Instrument,
  ScopeRings,
  Sfx,
  SidPatch,
  Song,
  SongPosition,
  Synth,
  SynthOptions,
} from "../types.ts";
import { CHIP_IDS, SCOPE_FRAMES } from "../types.ts";
import type { ChannelHost } from "./channel.ts";
import { Channel } from "./channel.ts";
import { EventRing } from "./events.ts";
import type { InstRt, SampleRt } from "./inst.ts";
import { compileInstrument, SRC_SID } from "./inst.ts";
import {
  advanceScopeHead,
  createScopeRings,
  writeRing,
  zeroRing,
} from "./scope.ts";
import type { SeqHandler } from "./sequencer.ts";
import { SongPlayer } from "./sequencer.ts";
import type { SfxProgram } from "./sfx-compile.ts";
import { compileSfx } from "./sfx-compile.ts";
import type { RowMark, SongTimeline, TimelineEvent } from "./timeline.ts";
import { compileSong } from "./timeline.ts";
import type { MixSinks } from "./voice.ts";
import { BLOCK, Voice } from "./voice.ts";

const MAX_SONG_VOICES = 10;
/** Master gain used when no song says otherwise (the project default). */
const DEFAULT_MASTER = 0.8;
const MAX_SAMPLE_SECONDS = 4;

interface SidFilterState {
  cutoff: number;
  mode: number;
  resonance: number;
  sweep: number;
}

export class SynthImpl implements Synth, ChannelHost, SeqHandler {
  readonly sampleRate: number;
  scopes: ScopeRings;
  tickRate = 60;

  private frameNow = 0;
  private readonly scopeFrames: number;
  private readonly songVoices: Voice[] = [];
  private readonly sfxVoices: Voice[] = [];
  private readonly channelList: Channel[] = [];
  private readonly buses: ChipBus[] = [];
  private readonly limiter: Limiter;
  private readonly echo: Echo;
  private readonly reverb: Reverb;
  private readonly sinks: MixSinks;
  private readonly noSinks: MixSinks;
  private readonly events = new EventRing();
  private readonly player: SongPlayer;
  private readonly mixL = new Float32Array(BLOCK);
  private readonly mixR = new Float32Array(BLOCK);
  private readonly stems: Float32Array[] = [];
  private readonly sidIn = new Float32Array(BLOCK);
  private readonly sidSvf: Svf = newSvf();
  private readonly sidState: SidFilterState = {
    cutoff: 0.5,
    mode: 0,
    resonance: 0,
    sweep: 0,
  };
  private sidOsc: Voice["sid"][] = [];
  private sidOuts: Float32Array[] = [];
  private sidVoices: Voice[] = [];
  private sidRoutedNow = false;
  /** Offline renders: copy each channel's dry stem of every block into blockStems. */
  captureStems = false;
  readonly blockStems: Float32Array[] = [];

  // loaded documents
  private song: Song | null = null;
  private timeline: SongTimeline | null = null;
  private chip: ChipId = "custom";
  private profile: ChipProfile = CUSTOM;
  private chanInfo: readonly ChipChannel[] = CUSTOM.channels;
  private chanCount = 0;
  private readonly instDocs = new Map<string, Instrument>();
  private readonly instRt = new Map<string, InstRt>();
  private readonly sfxProgs = new Map<string, SfxProgram>();
  private readonly sampleCache = new Map<string, SampleRt>();
  private songBaseTempo = 120;

  // clocks
  private tickFrames: number;
  private tickK = 0;
  private nextTick = 0;
  private handleCounter = 1;
  private seed = 1;
  private soloMask = 0;
  private masterGain = DEFAULT_MASTER;
  private userMaster = 1;

  constructor(opts: SynthOptions) {
    this.sampleRate = opts.sampleRate;
    this.scopeFrames = opts.scopeFrames ?? SCOPE_FRAMES;
    this.scopes = createScopeRings(this.scopeFrames, opts.scopeBuffer ?? null);
    const sfxCount = Math.max(1, Math.min(32, Math.floor(opts.sfxVoices ?? 8)));
    for (let i = 0; i < MAX_SONG_VOICES; i += 1) {
      this.songVoices.push(new Voice(this.sampleRate));
      this.stems.push(new Float32Array(BLOCK));
      this.blockStems.push(new Float32Array(BLOCK));
    }
    for (let i = 0; i < sfxCount; i += 1) {
      this.sfxVoices.push(new Voice(this.sampleRate));
    }
    for (const id of CHIP_IDS) {
      this.buses.push(new ChipBus(id, this.sampleRate));
    }
    this.limiter = new Limiter(this.sampleRate);
    this.echo = new Echo(this.sampleRate);
    this.reverb = new Reverb(this.sampleRate);
    this.sinks = {
      echoL: new Float32Array(BLOCK),
      echoR: new Float32Array(BLOCK),
      enabled: false,
      revL: new Float32Array(BLOCK),
      revR: new Float32Array(BLOCK),
    };
    this.noSinks = { ...this.sinks, enabled: false };
    this.player = new SongPlayer(this.sampleRate);
    this.tickFrames = this.sampleRate / this.tickRate;
    for (let i = 0; i < MAX_SONG_VOICES; i += 1) {
      const v = this.songVoices[i];
      if (v) {
        this.channelList.push(
          new Channel(
            i,
            v,
            CUSTOM.channels[0] ?? { id: "pulse", kind: "pulse", label: "" },
            this
          )
        );
      }
    }
    this.enterPreview();
  }

  // ---------------------------------------------------------------- Synth getters

  get frame(): number {
    return this.frameNow;
  }

  get playing(): boolean {
    return this.player.running;
  }

  channels(): readonly ChipChannel[] {
    return this.chanInfo;
  }

  setSeed(seed: number): void {
    this.seed = seed;
    this.reseedNoise();
  }

  private reseedNoise(): void {
    for (let i = 0; i < MAX_SONG_VOICES; i += 1) {
      const v = this.songVoices[i];
      if (v) {
        v.noiseSeed = deriveSeed(this.seed, i);
        v.noiseDirty = true;
      }
    }
  }

  // ---------------------------------------------------------------- ChannelHost

  instrument(id: string): InstRt | undefined {
    return this.instRt.get(id);
  }

  emitNote(
    frame: number,
    channel: Channel,
    type: "noteOn" | "noteOff",
    note: number,
    velocity: number,
    instId: string
  ): void {
    this.events.push(
      type,
      frame,
      channel.index,
      channel.info.id,
      note,
      type === "noteOn" ? noteToHz(note) : 0,
      velocity,
      instId,
      -1,
      -1
    );
  }

  sidFilterTrigger(f: SidPatch["filter"]): void {
    const st = this.sidState;
    st.cutoff = f.cutoff;
    st.resonance = f.resonance;
    st.mode = sidFilterMode(f.mode);
    st.sweep = f.sweep;
    setSidFilter(
      this.sidSvf,
      st.cutoff,
      st.resonance,
      st.mode,
      this.sampleRate
    );
  }

  // ---------------------------------------------------------------- loading

  private enterPreview(): void {
    this.song = null;
    this.timeline = null;
    this.chip = "custom";
    this.profile = CUSTOM;
    this.chanInfo = CUSTOM.channels;
    this.setupChannels(null);
    this.echo.disable();
    this.reverb.disable();
    this.masterGain = DEFAULT_MASTER;
    this.tickRate = 60;
    this.retime();
    this.player.unload();
  }

  private setupChannels(song: Song | null): void {
    this.chanCount = Math.min(MAX_SONG_VOICES, this.chanInfo.length);
    this.soloMask = 0;
    for (let i = 0; i < MAX_SONG_VOICES; i += 1) {
      const ch = this.channelList[i];
      if (!ch) {
        continue;
      }
      ch.voice.kill();
      ch.resetState();
      const info = this.chanInfo[i];
      if (info && i < this.chanCount) {
        ch.info = info;
        ch.voice.setChip(this.chip);
        const sc = song?.channels.find((c) => c.id === info.id);
        ch.songVolume = sc?.volume ?? 1;
        ch.songPan = sc?.pan ?? 0;
        ch.muted = sc?.muted ?? false;
      } else {
        ch.muted = false;
      }
      ch.userVolume = 1;
      ch.userPan = null;
      ch.silenced = false;
    }
    this.sidVoices = [];
    this.sidOsc = [];
    this.sidOuts = [];
    for (let i = 0; i < this.chanCount && this.sidVoices.length < 3; i += 1) {
      const info = this.chanInfo[i];
      const v = this.songVoices[i];
      if (info?.kind === "sid" && v) {
        this.sidVoices.push(v);
        this.sidOsc.push(v.sid);
        this.sidOuts.push(v.xbuf);
      }
    }
    this.reseedNoise();
  }

  private retime(): void {
    this.tickFrames = this.sampleRate / this.tickRate;
    this.tickK = Math.ceil(this.frameNow / this.tickFrames);
    this.nextTick = Math.ceil(this.tickK * this.tickFrames - 1e-6);
  }

  private sampleFor(inst: Instrument, _id: string): SampleRt | null {
    const p = inst.sample;
    if (!p) {
      return null;
    }
    const rate = this.profile.sampleRate ?? this.sampleRate;
    const key = `${p.generator}|${JSON.stringify(p.params)}|${p.seed}|${rate}|${p.baseNote}|${p.loop ? 1 : 0}`;
    const hit = this.sampleCache.get(key);
    if (hit) {
      return hit;
    }
    const g = generateSample(p.generator, p.params, p.seed, rate);
    const max = Math.round(MAX_SAMPLE_SECONDS * g.sampleRate);
    const data = g.data.length > max ? g.data.subarray(0, max) : g.data;
    const loops =
      p.loop &&
      g.loopStart !== null &&
      g.loopEnd !== null &&
      g.loopEnd > g.loopStart;
    const rt: SampleRt = {
      baseNote: p.baseNote,
      data,
      loopEnd: Math.min(g.loopEnd ?? data.length, data.length),
      loopStart: g.loopStart ?? 0,
      loops,
      rate: g.sampleRate,
    };
    this.sampleCache.set(key, rt);
    return rt;
  }

  private compile(id: string, inst: Instrument): InstRt {
    const rt = compileInstrument(id, inst, this.chip, this.profile);
    rt.sample = this.sampleFor(inst, id);
    return rt;
  }

  loadSong(song: Song, instruments: Record<string, Instrument>): void {
    this.unloadSong();
    this.song = song;
    this.chip = song.chip;
    this.profile = CHIPS[song.chip];
    this.chanInfo = chipChannels(song);
    this.instDocs.clear();
    this.instRt.clear();
    for (const [id, inst] of Object.entries(instruments)) {
      this.instDocs.set(id, inst);
      this.instRt.set(id, this.compile(id, inst));
    }
    this.timeline = compileSong(song, instruments);
    this.songBaseTempo = song.tempo;
    this.tickRate = song.tickRate;
    this.retime();
    this.setupChannels(song);
    for (let i = 0; i < this.chanCount; i += 1) {
      const sc = song.channels.find((c) => c.id === this.chanInfo[i]?.id);
      if (sc?.instrument) {
        this.channelList[i]?.setState(sc.instrument, null);
      }
    }
    this.masterGain = song.master.volume;
    if (song.master.echo && this.profile.constraints.masterFx) {
      this.echo.configure(
        song.master.echo.delay,
        song.master.echo.feedback,
        song.master.echo.level,
        song.master.echo.lowpassHz
      );
      this.echo.reset();
    } else {
      this.echo.disable();
    }
    if (song.master.reverb && this.profile.constraints.masterFx) {
      this.reverb.configure(
        song.master.reverb.size,
        song.master.reverb.damping,
        song.master.reverb.level
      );
      this.reverb.reset();
    } else {
      this.reverb.disable();
    }
    this.sinks.enabled = this.echo.enabled || this.reverb.enabled;
    this.player.load(this.timeline);
    this.player.tempoScale = 1;
    this.player.seekPulse(0, this.frameNow, (c, inst, vol) =>
      this.channelList[c]?.setState(inst, vol)
    );
    this.player.running = false;
  }

  unloadSong(): void {
    for (let i = 0; i < MAX_SONG_VOICES; i += 1) {
      this.channelList[i]?.voice.kill();
    }
    this.instDocs.clear();
    this.instRt.clear();
    this.enterPreview();
  }

  loadSfx(id: string, sfx: Sfx): void {
    this.sfxProgs.set(id, compileSfx(sfx, this.sampleRate));
  }

  unloadSfx(id: string): void {
    this.sfxProgs.delete(id);
  }

  setInstrument(id: string, inst: Instrument): void {
    this.instDocs.set(id, inst);
    const rt = this.compile(id, inst);
    this.instRt.set(id, rt);
    for (let i = 0; i < this.chanCount; i += 1) {
      const ch = this.channelList[i];
      if (ch && ch.inst?.id === id) {
        ch.inst = rt;
        if (ch.voice.active && ch.voice.rt?.id === id) {
          ch.voice.bindInstrument(rt, true);
          ch.apply(false);
        }
      }
    }
  }

  // ---------------------------------------------------------------- transport

  play(opts?: { order?: number; row?: number; loop?: boolean }): void {
    const tl = this.timeline;
    if (!tl) {
      return;
    }
    const loops = opts?.loop === false ? 1 : Number.POSITIVE_INFINITY;
    const state = (
      c: number,
      inst: string | null,
      vol: number | null
    ): void => {
      this.channelList[c]?.setState(inst, vol);
    };
    if (opts?.order !== undefined) {
      this.releaseAll(true);
      this.reseedNoise();
      this.player.start(
        this.player.pulseOf(opts.order, opts.row ?? 0),
        this.frameNow,
        loops,
        state
      );
      return;
    }
    if (this.player.running) {
      this.player.loopsRemaining = loops;
      return;
    }
    if (this.player.ended) {
      this.releaseAll(true);
      this.reseedNoise();
      this.player.start(0, this.frameNow, loops, state);
      return;
    }
    this.player.loopsRemaining = loops;
    this.player.resume(this.frameNow);
  }

  /** Start playing for an offline render: the loop section plays `loops` times, then the song ends. */
  playForRender(loops: number): void {
    const tl = this.timeline;
    if (!tl) {
      return;
    }
    this.releaseAll(true);
    this.reseedNoise();
    this.player.start(
      0,
      this.frameNow,
      Math.max(1, Math.floor(loops)),
      (c, inst, vol) => this.channelList[c]?.setState(inst, vol)
    );
  }

  /** True once a non-looping song reached its end. */
  get ended(): boolean {
    return this.player.ended;
  }

  stop(): void {
    this.player.pause(this.frameNow);
    this.releaseAll(false);
  }

  pause(): void {
    this.player.pause(this.frameNow);
  }

  seek(order: number, row: number): void {
    if (!this.timeline) {
      return;
    }
    const was = this.player.running;
    this.releaseAll(true);
    const p = this.player.pulseOf(order, row);
    this.player.seekPulse(p, this.frameNow, (c, inst, vol) =>
      this.channelList[c]?.setState(inst, vol)
    );
    if (was) {
      this.player.running = true;
    } else {
      this.player.running = false;
    }
  }

  setTempo(tempo: number): void {
    this.player.setTempoScale(
      Math.max(20, Math.min(400, tempo)) / this.songBaseTempo,
      this.frameNow
    );
  }

  private releaseAll(silent: boolean): void {
    for (let i = 0; i < this.chanCount; i += 1) {
      this.channelList[i]?.noteOff(this.frameNow, silent);
    }
  }

  position(): SongPosition | null {
    const tl = this.timeline;
    if (!tl) {
      return null;
    }
    const pulse = this.player.pulseAt(this.frameNow);
    const mark = this.player.currentRow();
    if (!mark) {
      return { order: 0, pulse, row: 0, tick: 0 };
    }
    const sinceRow =
      Math.max(0, pulse - mark.pulse) * this.player.samplesPerPulse();
    return {
      order: mark.order,
      pulse,
      row: mark.row,
      tick: Math.floor(sinceRow / this.tickFrames),
    };
  }

  // ---------------------------------------------------------------- sfx and manual notes

  /** An sfx voice that is idle, or null when every one is busy. */
  private freeSfxVoice(): Voice | null {
    for (const v of this.sfxVoices) {
      if (!(v.active || v.pending)) {
        return v;
      }
    }
    return null;
  }

  /** The sfx voice to steal: the quietest one already releasing, else the oldest one not about to start. */
  private stealableSfxVoice(): Voice | null {
    let target: Voice | null = null;
    let lowest = Number.POSITIVE_INFINITY;
    for (const v of this.sfxVoices) {
      if (v.sfxReleased && !v.pending) {
        const lvl = v.currentLevel();
        if (lvl < lowest) {
          lowest = lvl;
          target = v;
        }
      }
    }
    if (target) {
      return target;
    }
    let oldest = Number.POSITIVE_INFINITY;
    for (const v of this.sfxVoices) {
      if (!v.pending && v.startFrame < oldest) {
        oldest = v.startFrame;
        target = v;
      }
    }
    return target ?? this.sfxVoices[0] ?? null;
  }

  trigger(
    id: string,
    opts?: { velocity?: number; pan?: number; pitch?: number; seed?: number }
  ): number {
    const prog = this.sfxProgs.get(id);
    if (!prog) {
      return 0;
    }
    let target = this.freeSfxVoice();
    const steal = target === null;
    target ??= this.stealableSfxVoice();
    if (!target) {
      return 0;
    }
    const velocity = Math.max(0, Math.min(1, opts?.velocity ?? 1));
    const pan = opts?.pan ?? 0;
    const pitch = opts?.pitch ?? 0;
    const seed = opts?.seed ?? this.seed;
    const handle = this.handleCounter;
    this.handleCounter =
      this.handleCounter >= 0x7f_ff_ff_ff ? 1 : this.handleCounter + 1;
    target.handle = handle;
    target.startFrame = this.frameNow;
    if (steal && target.active) {
      target.stealFor(prog, velocity, pan, pitch, seed);
    } else {
      target.startSfx(prog, velocity, pan, pitch, seed);
    }
    this.events.push(
      "trigger",
      this.frameNow,
      -1,
      "",
      0,
      prog.startHz,
      velocity,
      id,
      -1,
      -1
    );
    return handle;
  }

  release(handle: number): void {
    if (handle <= 0) {
      return;
    }
    for (const v of this.sfxVoices) {
      if (v.handle === handle) {
        v.releaseSfx();
        return;
      }
    }
  }

  noteOn(
    channel: number,
    note: number,
    velocity: number,
    instrument?: string
  ): void {
    if (channel < 0 || channel >= this.chanCount) {
      return;
    }
    const ch = this.channelList[channel];
    if (!ch) {
      return;
    }
    const id = instrument ?? (ch.instId || null);
    if (id === null || !this.instRt.has(id)) {
      return;
    }
    ch.noteOn(
      this.frameNow,
      note,
      id,
      null,
      [],
      Math.max(0, Math.min(1, velocity))
    );
  }

  noteOff(channel: number): void {
    if (channel < 0 || channel >= this.chanCount) {
      return;
    }
    this.channelList[channel]?.noteOff(this.frameNow, false);
  }

  setChannel(
    channel: number,
    opts: { muted?: boolean; solo?: boolean; volume?: number; pan?: number }
  ): void {
    if (channel < 0 || channel >= this.chanCount) {
      return;
    }
    const ch = this.channelList[channel];
    if (!ch) {
      return;
    }
    if (opts.muted !== undefined) {
      ch.muted = opts.muted;
    }
    if (opts.volume !== undefined) {
      ch.userVolume = Math.max(0, Math.min(2, opts.volume));
    }
    if (opts.pan !== undefined) {
      ch.userPan = Math.max(-1, Math.min(1, opts.pan));
    }
    if (opts.solo !== undefined) {
      this.soloMask = opts.solo
        ? this.soloMask | (1 << channel)
        : this.soloMask & ~(1 << channel);
      for (let i = 0; i < this.chanCount; i += 1) {
        const c = this.channelList[i];
        if (c) {
          c.silenced = this.soloMask !== 0 && (this.soloMask & (1 << i)) === 0;
        }
      }
    }
    if (ch.voice.active) {
      ch.apply(false);
    }
    for (let i = 0; i < this.chanCount; i += 1) {
      const c = this.channelList[i];
      if (c?.voice.active && c !== ch) {
        c.apply(false);
      }
    }
  }

  setMaster(opts: { volume?: number; limiter?: boolean }): void {
    if (opts.volume !== undefined) {
      this.userMaster = Math.max(0, Math.min(2, opts.volume));
    }
    if (opts.limiter !== undefined) {
      this.limiter.enabled = opts.limiter;
    }
  }

  setScopeBuffer(buffer: SharedArrayBuffer | null): void {
    this.scopes = createScopeRings(this.scopeFrames, buffer);
  }

  // ---------------------------------------------------------------- sequencer callbacks

  onRow(frame: number, mark: RowMark): void {
    const song = this.song;
    const id = song?.order[mark.order] ?? "";
    this.events.push("row", frame, -1, "", 0, 0, 0, id, mark.order, mark.row);
  }

  onEvent(frame: number, channel: number, e: TimelineEvent): void {
    const ch = this.channelList[channel];
    if (!ch || channel >= this.chanCount) {
      return;
    }
    switch (e.type) {
      case "note":
        ch.noteOn(frame, e.note, e.inst, e.vol, e.fx, 1);
        break;
      case "off":
      case "release":
        ch.noteOff(frame, false);
        break;
      default:
        ch.fxOnly(e.inst, e.vol, e.fx);
        break;
    }
  }

  onLoop(frame: number): void {
    this.events.push("loop", frame, -1, "", 0, 0, 0, "", -1, -1);
  }

  onEnd(frame: number): void {
    this.releaseAll(false);
    this.events.push("end", frame, -1, "", 0, 0, 0, "", -1, -1);
  }

  // ---------------------------------------------------------------- process

  private doTick(frame: number): void {
    for (let i = 0; i < this.chanCount; i += 1) {
      this.channelList[i]?.tick(frame);
    }
    const st = this.sidState;
    if (st.sweep !== 0 && st.mode !== 0) {
      st.cutoff = Math.max(0, Math.min(1, st.cutoff + st.sweep));
      setSidFilter(
        this.sidSvf,
        st.cutoff,
        st.resonance,
        st.mode,
        this.sampleRate
      );
    }
  }

  process(
    left: Float32Array,
    right: Float32Array,
    frames: number,
    out: EngineEvent[]
  ): void {
    let done = 0;
    const total = Math.min(frames, BLOCK);
    if (this.captureStems) {
      for (const b of this.blockStems) {
        b.fill(0, 0, total);
      }
    }
    while (done < total) {
      const f0 = this.frameNow;
      while (this.nextTick <= f0) {
        this.doTick(this.nextTick);
        this.tickK += 1;
        this.nextTick = Math.ceil(this.tickK * this.tickFrames - 1e-6);
      }
      if (this.player.running) {
        this.player.advance(f0, this);
      }
      let seg = total - done;
      const toTick = this.nextTick - f0;
      if (toTick < seg) {
        seg = toTick;
      }
      if (this.player.running) {
        const toEvent = this.player.nextFrame() - f0;
        if (toEvent < seg) {
          seg = toEvent;
        }
      }
      if (seg < 1) {
        seg = 1;
      }
      this.renderSegment(left, right, done, seg);
      this.frameNow += seg;
      done += seg;
    }
    this.events.drain(out);
  }

  private renderSegment(
    left: Float32Array,
    right: Float32Array,
    off: number,
    n: number
  ): void {
    const mixL = this.mixL;
    const mixR = this.mixR;
    const sinks = this.sinks;
    const head = this.scopes.head[0] ?? 0;
    if (sinks.enabled) {
      sinks.echoL.fill(0, 0, n);
      sinks.echoR.fill(0, 0, n);
      sinks.revL.fill(0, 0, n);
      sinks.revR.fill(0, 0, n);
    }
    const songBus = this.buses[CHIP_IDS.indexOf(this.chip)];
    // SID oscillators render together so ring modulation and sync see their neighbours
    let sidAny = false;
    for (const v of this.sidVoices) {
      if (v.active) {
        sidAny = true;
      }
    }
    if (sidAny) {
      renderSidGroup(this.sidOsc, this.sidOuts, n);
    }
    let routed = false;
    this.sidIn.fill(0, 0, n);
    for (let c = 0; c < MAX_SONG_VOICES; c += 1) {
      const ring = this.scopes.channels[c];
      const stem = this.stems[c];
      const ch = this.channelList[c];
      if (
        !(ring && stem && ch) ||
        c >= this.chanCount ||
        !ch.voice.active ||
        !songBus
      ) {
        if (ring) {
          zeroRing(ring, n, head);
        }
        continue;
      }
      const v = ch.voice;
      v.render(n, v.src === SRC_SID);
      const viaSid = v.src === SRC_SID && v.sidRouted;
      if (viaSid) {
        routed = true;
      }
      v.mixTo(n, songBus, stem, sinks, viaSid ? this.sidIn : null);
      writeRing(ring, stem, n, head);
      if (this.captureStems) {
        this.blockStems[c]?.set(stem.subarray(0, n), off);
      }
    }
    // the SID filter: routed voices through the shared SVF, then into the bus
    if (routed && songBus) {
      svfProcess(this.sidSvf, this.sidIn, n);
      songBus.touch(n);
      const k = Math.SQRT1_2;
      for (let i = 0; i < n; i += 1) {
        const s = (this.sidIn[i] ?? 0) * k;
        songBus.l[i] = (songBus.l[i] ?? 0) + s;
        songBus.r[i] = (songBus.r[i] ?? 0) + s;
      }
      this.sidRoutedNow = true;
    } else if (this.sidRoutedNow) {
      svfReset(this.sidSvf);
      this.sidRoutedNow = false;
    }
    // sfx voices feed the bus of their own chip
    for (const v of this.sfxVoices) {
      if (!v.active) {
        continue;
      }
      v.render(n, false);
      const bus = this.buses[v.chipIdx];
      if (bus) {
        v.mixTo(n, bus, null, this.noSinks, null);
      }
    }
    // chip buses: coloring, then the sum
    mixL.fill(0, 0, n);
    mixR.fill(0, 0, n);
    for (const bus of this.buses) {
      if (!bus.needsRun()) {
        continue;
      }
      bus.process(n);
      for (let i = 0; i < n; i += 1) {
        mixL[i] = (mixL[i] ?? 0) + (bus.outL[i] ?? 0);
        mixR[i] = (mixR[i] ?? 0) + (bus.outR[i] ?? 0);
      }
    }
    // master effects, then the master gain and the limiter
    if (this.echo.enabled) {
      this.echo.process(sinks.echoL, sinks.echoR, mixL, mixR, n);
    }
    if (this.reverb.enabled) {
      this.reverb.process(sinks.revL, sinks.revR, mixL, mixR, n);
    }
    const gain = this.masterGain * this.userMaster;
    for (let i = 0; i < n; i += 1) {
      mixL[i] = (mixL[i] ?? 0) * gain;
      mixR[i] = (mixR[i] ?? 0) * gain;
    }
    this.limiter.process(mixL, mixR, n);
    for (let i = 0; i < n; i += 1) {
      left[off + i] = mixL[i] ?? 0;
      right[off + i] = mixR[i] ?? 0;
    }
    writeRing(this.scopes.master[0], mixL, n, head);
    writeRing(this.scopes.master[1], mixR, n, head);
    advanceScopeHead(this.scopes, n);
  }

  /** Frames of delay the limiter adds (offline renders trim them). */
  get latency(): number {
    return this.limiter.latency;
  }
}

export function createSynth(opts: SynthOptions): Synth {
  return new SynthImpl(opts);
}
