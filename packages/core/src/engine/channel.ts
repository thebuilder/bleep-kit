/* Channel: a song slot (section 3.2). It owns one Voice and the sequencer state for its track: current instrument,
   volume column, active tracker effects and the portamento target. Per tick the order is: macros, then effects
   (effects win), then the voice applies chip quantization. */

import { sinCycles, sineTable } from "../dsp/tables.ts";
import { effectByte } from "../normalize/effects.ts";
import type { ChipChannel, Effect, SidPatch } from "../types.ts";
import type { InstRt } from "./inst.ts";
import { DEFAULT_DUTIES, SRC_FM, SRC_PULSE, SRC_SID } from "./inst.ts";
import type { Voice } from "./voice.ts";

/** What a channel needs from the synth. */
export interface ChannelHost {
  emitNote: (
    frame: number,
    channel: Channel,
    type: "noteOn" | "noteOff",
    note: number,
    velocity: number,
    instId: string
  ) => void;
  instrument: (id: string) => InstRt | undefined;
  sidFilterTrigger: (f: SidPatch["filter"]) => void;
  readonly tickRate: number;
}

const SID_MASK: Readonly<Record<string, number>> = {
  noise: 8,
  pulse: 4,
  saw: 2,
  tri: 1,
};

export class Channel {
  readonly index: number;
  readonly voice: Voice;
  info: ChipChannel;
  host: ChannelHost;

  // song and user settings
  songVolume = 1;
  songPan = 0;
  userVolume = 1;
  userPan: number | null = null;
  muted = false;
  /** Set by the synth: a solo is active and this channel is not part of it. */
  silenced = false;

  inst: InstRt | null = null;
  instId = "";
  volCol = 1;
  velocity = 1;

  // pitch
  playing = false;
  baseNote = 60;
  curNote = 60;
  portaTarget = 60;
  portaSpeed = 0;
  slideRate = 0;
  slideAcc = 0;
  nsAcc = 0;
  nsTarget = 0;
  nsRate = 0;
  /** A note slide was set by the row being played and belongs to the note that starts on it. */
  nsFresh = false;
  pitchFine = 0;
  pitchAcc = 0;

  // effects
  arpOn = false;
  arpX = 0;
  arpY = 0;
  arpIdx = 0;
  vibSpeed = 0;
  vibDepth = 0;
  vibPhase = 0;
  tremSpeed = 0;
  tremDepth = 0;
  tremPhase = 0;
  volSlide = 0;
  cutLeft = -1;
  retrigEvery = 0;
  retrigCount = 0;
  delayLeft = -1;
  delayNote = 60;
  delayVel = 1;
  dutyOverride = -1;
  panOverride: number | null = null;
  sendOverride = -1;
  pwmPhase = 0;
  lfoPhase = 0;

  constructor(
    index: number,
    voice: Voice,
    info: ChipChannel,
    host: ChannelHost
  ) {
    this.index = index;
    this.voice = voice;
    this.info = info;
    this.host = host;
  }

  /** Forget everything about the current note and song state (new song, seek, play from the top). */
  resetState(): void {
    this.voice.kill();
    this.playing = false;
    this.inst = null;
    this.instId = "";
    this.volCol = 1;
    this.velocity = 1;
    this.clearEffects();
    this.portaSpeed = 0;
    this.pitchFine = 0;
    this.dutyOverride = -1;
    this.panOverride = null;
    this.sendOverride = -1;
    this.delayLeft = -1;
  }

  private clearEffects(): void {
    this.arpOn = false;
    this.arpIdx = 0;
    this.slideRate = 0;
    this.vibSpeed = 0;
    this.tremSpeed = 0;
    this.volSlide = 0;
    this.cutLeft = -1;
    this.retrigEvery = 0;
    this.retrigCount = 0;
  }

  /** Persistent state set by events before a seek position, without sounding anything. */
  setState(instId: string | null, vol: number | null): void {
    if (instId !== null) {
      const rt = this.host.instrument(instId);
      if (rt) {
        this.inst = rt;
        this.instId = instId;
      }
    }
    if (vol !== null) {
      this.volCol = vol / 15;
    }
  }

  // ---------------------------------------------------------------- events

  /** The instrument and volume column of a row: both apply whether or not the row has a note. */
  private applyRowHead(instId: string | null, vol: number | null): void {
    if (instId !== null) {
      const rt = this.host.instrument(instId);
      if (rt) {
        if (rt !== this.inst) {
          this.dutyOverride = -1;
        }
        this.inst = rt;
        this.instId = instId;
      }
    }
    if (vol !== null) {
      this.volCol = vol / 15;
    }
  }

  /** A note row or manual note. fx are applied first so that a delay (G) can postpone the trigger. */
  noteOn(
    frame: number,
    note: number,
    instId: string | null,
    vol: number | null,
    fx: readonly Effect[],
    velocity: number
  ): void {
    this.applyRowHead(instId, vol);
    this.velocity = velocity;
    this.delayLeft = -1;
    this.nsFresh = false;
    let delay = 0;
    for (const e of fx) {
      if (e.type === "delay") {
        delay = effectByte(e);
      } else {
        this.applyEffect(e);
      }
    }
    if (delay > 0) {
      this.delayLeft = delay;
      this.delayNote = note;
      this.delayVel = velocity;
      return;
    }
    this.start(frame, note);
  }

  /** Effects, volume or instrument on a row without a note. */
  fxOnly(
    instId: string | null,
    vol: number | null,
    fx: readonly Effect[]
  ): void {
    this.applyRowHead(instId, vol);
    for (const e of fx) {
      if (e.type !== "delay") {
        this.applyEffect(e);
      }
    }
    // there is no new note for a slide set here to wait for: it moves the sounding one
    this.nsFresh = false;
    if (this.playing) {
      this.apply(false);
    }
  }

  private start(frame: number, note: number): void {
    const rt = this.inst;
    if (!rt) {
      return;
    }
    const v = this.voice;
    const legato = this.portaSpeed > 0 && this.playing && v.active;
    if (legato) {
      this.portaTarget = note;
      this.baseNote = note;
      this.nsFresh = false;
      this.apply(false);
      return;
    }
    this.baseNote = note;
    this.curNote = note;
    this.portaTarget = note;
    this.slideAcc = 0;
    // a note starts from its own pitch: the old note's slide is over, but one set on this row starts with the note
    const slideRate = this.nsFresh ? this.nsRate : 0;
    const slideDistance = this.nsFresh ? this.nsTarget - this.nsAcc : 0;
    this.nsFresh = false;
    this.nsAcc = 0;
    this.nsRate = slideRate;
    this.nsTarget = slideDistance;
    this.pitchAcc = 0;
    this.arpIdx = 0;
    this.vibPhase = 0;
    this.tremPhase = 0;
    this.pwmPhase = 0;
    this.lfoPhase = 0;
    this.retrigCount = 0;
    const wasActive = v.active;
    v.noteOn(rt, note, frame);
    if (rt.src === SRC_SID && rt.inst.sid) {
      const f = rt.inst.sid.filter;
      v.sidRouted = f.mode !== "off";
      if (v.sidRouted) {
        this.host.sidFilterTrigger(f);
      }
    } else {
      v.sidRouted = false;
    }
    this.playing = true;
    this.apply(!wasActive);
    this.host.emitNote(frame, this, "noteOn", note, this.velocity, this.instId);
  }

  /** Note off (explicit, cut, or the end of the song). */
  noteOff(frame: number, silent: boolean): void {
    this.delayLeft = -1;
    this.clearEffects();
    if (!this.playing) {
      return;
    }
    this.playing = false;
    this.voice.noteOff();
    if (!silent) {
      this.host.emitNote(frame, this, "noteOff", this.baseNote, 0, this.instId);
    }
  }

  private applyEffect(e: Effect): void {
    const xx = effectByte(e);
    if (!this.applyPitchEffect(e, xx)) {
      this.applyLevelEffect(e, xx);
    }
  }

  /** Effects that move the pitch. False when `e` is not one of them. */
  private applyPitchEffect(e: Effect, xx: number): boolean {
    switch (e.type) {
      case "arp":
        this.arpOn = e.x !== 0 || e.y !== 0;
        this.arpX = e.x;
        this.arpY = e.y;
        return true;
      case "slideUp":
        this.slideRate = xx / 16;
        return true;
      case "slideDown":
        this.slideRate = -xx / 16;
        return true;
      case "portamento":
        this.portaSpeed = xx / 16;
        return true;
      case "vibrato":
        this.vibSpeed = e.x;
        this.vibDepth = e.y * 8;
        return true;
      case "pitch":
        this.pitchFine = (xx - 0x80) / 16;
        return true;
      case "noteSlideUp":
      case "noteSlideDown":
        if (e.x > 0 && e.y > 0) {
          this.nsRate = (e.x * 2) / 16;
          this.nsTarget = this.nsAcc + (e.type === "noteSlideUp" ? e.y : -e.y);
          this.nsFresh = true;
        }
        return true;
      default:
        return false;
    }
  }

  /** Effects on level, timbre, position and timing. Anything else (delay, flow effects) is not the channel's. */
  private applyLevelEffect(e: Effect, xx: number): void {
    switch (e.type) {
      case "tremolo":
        this.tremSpeed = e.x;
        this.tremDepth = e.y / 15;
        break;
      case "volSlide":
        this.volSlide = (e.x - e.y) / 16;
        break;
      case "duty":
        this.dutyOverride = xx;
        break;
      case "cut":
        this.cutLeft = xx;
        break;
      case "pan":
        this.panOverride = Math.max(-1, Math.min(1, (xx - 128) / 127));
        break;
      case "send":
        this.sendOverride = xx / 255;
        break;
      case "retrigger":
        this.retrigEvery = xx;
        this.retrigCount = 0;
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- ticks

  /** A note held back by a delay effect starts when its ticks have passed. */
  private runDelay(frame: number): void {
    if (this.delayLeft < 0) {
      return;
    }
    this.delayLeft -= 1;
    if (this.delayLeft <= 0) {
      this.delayLeft = -1;
      this.velocity = this.delayVel;
      this.start(frame, this.delayNote);
    }
  }

  /** Move the note slide and the portamento one tick toward their targets. */
  private stepGlides(): void {
    if (this.nsRate > 0 && this.nsAcc !== this.nsTarget) {
      const d = this.nsTarget - this.nsAcc;
      this.nsAcc =
        Math.abs(d) <= this.nsRate
          ? this.nsTarget
          : this.nsAcc + Math.sign(d) * this.nsRate;
    }
    if (this.portaSpeed > 0 && this.curNote !== this.portaTarget) {
      const d = this.portaTarget - this.curNote;
      this.curNote =
        Math.abs(d) <= this.portaSpeed
          ? this.portaTarget
          : this.curNote + Math.sign(d) * this.portaSpeed;
    }
  }

  /** The cut and retrigger countdowns. True when the cut ended the note. */
  private stepTimers(frame: number, rt: InstRt | null): boolean {
    if (this.cutLeft >= 0) {
      this.cutLeft -= 1;
      if (this.cutLeft <= 0) {
        this.cutLeft = -1;
        this.noteOff(frame, false);
        return true;
      }
    }
    if (this.retrigEvery > 0) {
      this.retrigCount += 1;
      if (this.retrigCount >= this.retrigEvery) {
        this.retrigCount = 0;
        if (rt) {
          this.voice.noteOn(rt, this.baseNote, frame);
        }
      }
    }
    return false;
  }

  /** The per-chip modulators that advance with the tick: the SID pulse width LFO and the FM LFO. */
  private stepChipLfos(rt: InstRt | null): void {
    if (rt?.src === SRC_SID && rt.inst.sid && rt.inst.sid.pwmRate > 0) {
      this.pwmPhase =
        (this.pwmPhase + rt.inst.sid.pwmRate / this.host.tickRate) % 1;
    }
    if (rt?.src === SRC_FM && rt.inst.fm?.lfo && rt.inst.fm.lfo.rate > 0) {
      this.lfoPhase =
        (this.lfoPhase + rt.inst.fm.lfo.rate / this.host.tickRate) % 1;
    }
  }

  /** One engine tick: macros, effects, then push everything to the voice. */
  tick(frame: number): void {
    this.runDelay(frame);
    if (!(this.playing && this.voice.active)) {
      if (this.playing && !this.voice.active) {
        this.playing = false;
      }
      return;
    }
    const v = this.voice;
    v.tickMacros();
    const rt = this.inst;
    if (rt?.macroPitch.present) {
      this.pitchAcc += v.mPitch.value;
    }
    if (this.arpOn) {
      this.arpIdx = (this.arpIdx + 1) % 3;
    }
    this.slideAcc += this.slideRate;
    this.stepGlides();
    this.vibPhase = (this.vibPhase + this.vibSpeed / 64) % 1;
    this.tremPhase = (this.tremPhase + this.tremSpeed / 64) % 1;
    if (this.volSlide !== 0) {
      this.volCol = Math.max(0, Math.min(1, this.volCol + this.volSlide));
    }
    if (this.stepTimers(frame, rt)) {
      return;
    }
    this.stepChipLfos(rt);
    this.apply(false);
  }

  /** The pitch in (fractional) notes: the arpeggio or macro, every slide and offset, then the vibrato. */
  private pitchNote(rt: InstRt, v: Voice, table: Float32Array): number {
    let n = this.curNote;
    if (this.arpOn) {
      const k = this.arpIdx % 3;
      n += k === 0 ? 0 : k === 1 ? this.arpX : this.arpY;
    } else if (rt.macroArp.present) {
      const m = v.mArp.value;
      n = rt.arpFixed ? m : n + m;
    }
    n +=
      this.slideAcc +
      this.nsAcc +
      this.pitchFine +
      this.pitchAcc / 100 +
      rt.transpose +
      rt.finetune / 100;
    if (this.vibSpeed > 0 && this.vibDepth > 0) {
      n += (this.vibDepth / 100) * sinCycles(table, this.vibPhase);
    }
    return n;
  }

  /** The output gain: instrument, song, user and column volumes, velocity, the macro and the tremolo. */
  private gainOf(
    rt: InstRt,
    v: Voice,
    table: Float32Array,
    ampLfo: number
  ): number {
    let gain =
      rt.volume *
      this.songVolume *
      this.userVolume *
      this.volCol *
      this.velocity *
      ampLfo;
    if (rt.macroVolume.present) {
      gain *= v.mVol.value;
    }
    if (this.tremSpeed > 0 && this.tremDepth > 0) {
      gain *=
        1 -
        this.tremDepth * (0.5 - 0.5 * sinCycles(table, this.tremPhase + 0.25));
    }
    return this.muted || this.silenced ? 0 : gain;
  }

  /** The pan: a pan effect wins, else song, instrument and macro together, and the user's pan over those. */
  private panOf(rt: InstRt, v: Voice): number {
    if (this.panOverride !== null) {
      return this.panOverride;
    }
    let pan = this.songPan + rt.pan;
    if (rt.macroPan.present) {
      pan += v.mPan.value;
    }
    return this.userPan ?? pan;
  }

  /** Pulse width: the chip's fixed one, the duty effect or macro picking from the duty list, else the instrument's. */
  private applyPulseDuty(rt: InstRt, v: Voice): void {
    if (this.info.fixedDuty !== undefined) {
      v.setDuty(this.info.fixedDuty);
      return;
    }
    let idx = this.dutyOverride;
    if (idx < 0 && rt.macroDuty.present) {
      idx = Math.round(v.mDuty.value);
    }
    if (idx >= 0) {
      const list = rt.duties.length > 0 ? rt.duties : DEFAULT_DUTIES;
      v.setDuty(list[Math.min(list.length - 1, idx)] ?? 0.5);
    } else {
      v.setDuty(rt.duty);
    }
  }

  /** SID waveform mask (the duty effect or macro override the patch's) and pulse width with its PWM. */
  private applySid(
    rt: InstRt,
    p: SidPatch,
    v: Voice,
    table: Float32Array
  ): void {
    let mask = 0;
    for (const w of p.waveforms) {
      mask |= SID_MASK[w] ?? 0;
    }
    if (this.dutyOverride >= 0) {
      mask = this.dutyOverride & 15;
    } else if (rt.macroDuty.present) {
      mask = Math.round(v.mDuty.value) & 15;
    }
    if (mask === 0) {
      mask = 4;
    }
    let pw = p.pulseWidth;
    if (p.pwmRate > 0 && p.pwmDepth > 0) {
      pw += p.pwmDepth * 0.5 * sinCycles(table, this.pwmPhase);
    }
    v.setSid(mask, Math.max(0.02, Math.min(0.98, pw)), p.ring, p.sync);
  }

  /** Compute pitch, gain, pan, duty and per-chip extras from the current state and hand them to the voice. */
  apply(immediate: boolean): void {
    const rt = this.inst;
    const v = this.voice;
    if (!rt) {
      return;
    }
    const table = sineTable();
    const n = this.pitchNote(rt, v, table);
    // the FM LFO moves the pitch (before setNote) and the level
    let ampLfo = 1;
    if (rt.src === SRC_FM && rt.inst.fm?.lfo) {
      const lfo = rt.inst.fm.lfo;
      const ph = this.lfoPhase;
      v.fm.lfoPitch = lfo.pitchDepth * sinCycles(table, ph);
      ampLfo = 1 - lfo.ampDepth * (0.5 - 0.5 * sinCycles(table, ph + 0.25));
    }
    v.setNote(n);
    v.setGain(this.gainOf(rt, v, table, ampLfo), immediate);
    v.setPan(this.panOf(rt, v), immediate);
    if (rt.src === SRC_PULSE) {
      this.applyPulseDuty(rt, v);
    } else if (rt.src === SRC_SID && rt.inst.sid) {
      this.applySid(rt, rt.inst.sid, v, table);
    } else if (rt.src === SRC_FM && this.dutyOverride >= 0) {
      v.setFmAlgorithm(this.dutyOverride);
    }
    if (this.sendOverride >= 0) {
      v.sendEcho = this.sendOverride;
    }
  }
}
