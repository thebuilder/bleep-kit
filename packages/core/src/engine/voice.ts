/* Voice: the DSP unit (section 3.2). One class runs every source model: oscillators, noise, wavetable, FM, SID and
   sample playback, then the envelope, chip volume quantization and (for sfx) the program and its effects.
   Nothing in render() allocates. */

import {
  C64_CLOCK_HZ,
  hzToPeriod as c64HzToPeriod,
  periodToHz as c64PeriodToHz,
  quantizeHz as c64QuantizeHz,
} from "../chips/c64.ts";
import {
  quantizeNoiseRate as gbQuantizeNoiseRate,
  quantizePulseHz as gbQuantizePulseHz,
  quantizeWaveHz as gbQuantizeWaveHz,
} from "../chips/gameboy.ts";
import {
  quantizeHz as genesisQuantizeHz,
  quantizeNoiseRate as genesisQuantizeNoiseRate,
  quantizeTone3NoiseRate as genesisQuantizeTone3Rate,
} from "../chips/genesis.ts";
import { CHIPS } from "../chips/index.ts";
import {
  quantizeNoiseRate as nesQuantizeNoiseRate,
  quantizePulseHz as nesQuantizePulseHz,
  quantizeTriangleHz as nesQuantizeTriangleHz,
} from "../chips/nes.ts";
import type { ChipBus } from "../dsp/color.ts";
import type { EnvelopeState } from "../dsp/envelope.ts";
import {
  ENV_IDLE,
  ENV_SUSTAIN,
  envelopeDamp,
  envelopeRelease,
  envelopeTrigger,
  MIN_ATTACK,
  newEnvelope,
  runEnvelope,
  setEnvelopeParams,
} from "../dsp/envelope.ts";
import type { FmRt, FmState } from "../dsp/fm.ts";
import {
  fmNoteOff,
  fmNoteOn,
  fmReset,
  fmSetAlgorithm,
  fmSetPitch,
  fmSilent,
  newFmState,
  renderFm,
} from "../dsp/fm.ts";
import type { MacroRt } from "../dsp/macro.ts";
import {
  macroBind,
  macroRelease,
  macroStart,
  macroTick,
  newMacroRt,
} from "../dsp/macro.ts";
import type { NoiseState } from "../dsp/noise.ts";
import {
  NOISE_GB_LONG,
  NOISE_GB_SHORT,
  NOISE_NES_LONG,
  NOISE_NES_SHORT,
  NOISE_PSG_PERIODIC,
  NOISE_PSG_WHITE,
  NOISE_WHITE,
  newNoise,
  renderNoise,
  seedNoise,
} from "../dsp/noise.ts";
import type { PhaseState } from "../dsp/osc.ts";
import {
  MAX_DT,
  newPhase,
  renderPulse,
  renderSaw,
  renderSine,
  renderStepped,
  renderTriangle,
} from "../dsp/osc.ts";
import type { SfxFx } from "../dsp/sfxfx.ts";
import {
  newSfxFx,
  onePoleCoef,
  resetSfxFx,
  runBitcrush,
  runHighpass,
  runLowpass,
  runPhaser,
} from "../dsp/sfxfx.ts";
import type { SidOsc } from "../dsp/sid.ts";
import { newSidOsc, sidSetRate } from "../dsp/sid.ts";
import {
  logQuantTable,
  nesTriangleTable,
  QUANT_RES,
  sineTable,
} from "../dsp/tables.ts";
import { nearest } from "../nearest.ts";
import { noteToHz } from "../notes.ts";
import type { ChipId, ChipProfile } from "../types.ts";
import { CHIP_IDS } from "../types.ts";
import type { InstRt, SampleRt } from "./inst.ts";
import {
  SRC_FM,
  SRC_NOISE,
  SRC_PULSE,
  SRC_SAMPLE,
  SRC_SAW,
  SRC_SID,
  SRC_SINE,
  SRC_TRI,
  SRC_WAVE,
} from "./inst.ts";
import type { SfxProgram } from "./sfx-compile.ts";

export const BLOCK = 128;

/** Where song voices send their signal for the master effects. */
export interface MixSinks {
  echoL: Float32Array;
  echoR: Float32Array;
  enabled: boolean;
  revL: Float32Array;
  revR: Float32Array;
}

const Q_NONE = 0;
const Q_LINEAR = 1;
const Q_LOG = 2;

/** Which NES mixer group a voice feeds. */
const GROUP_NONE = 0;
const GROUP_PULSE = 1;
const GROUP_TND = 2;

const CHIP_INDEX: Readonly<Record<ChipId, number>> = Object.fromEntries(
  CHIP_IDS.map((c, i) => [c, i])
) as Record<ChipId, number>;
const CI_NES = CHIP_INDEX.nes;
const CI_GB = CHIP_INDEX.gameboy;
const CI_C64 = CHIP_INDEX.c64;
const CI_GENESIS = CHIP_INDEX.genesis;
const CI_ADLIB = CHIP_INDEX.adlib;

const SMOOTH_SECONDS = 0.0005;
const PAN_SECONDS = 0.003;
/** Corner of the per-voice DC tracker. */
const DC_HZ = 12;
/** A retriggered voice cross-fades its old output away with a decaying offset of this time constant. */
const DECLICK_SECONDS = 0.001;
/** Sfx program control (pitch, filters, duty) is updated on a grid of this many frames of the voice's own clock, so the
    result does not depend on how the host splits blocks. */
const SFX_CTRL = 32;
const STEAL_SECONDS = 0.002;
const SFX_END_FADE = 0.001;
/** Throwaway output for replaying the noise register up to the frame an envelope fell idle. */
const NOISE_SCRATCH = new Float32Array(BLOCK);
const TWO_PI = 2 * Math.PI;

export class Voice {
  readonly sr: number;
  readonly xbuf = new Float32Array(BLOCK);
  readonly gbuf = new Float32Array(BLOCK);
  readonly ebuf = new Float32Array(BLOCK);
  private readonly wx = new Float32Array(BLOCK);
  private readonly wg = new Float32Array(BLOCK);

  // identity
  chip: ChipId = "nes";
  chipIdx = CI_NES;
  profile: ChipProfile = CHIPS.nes;
  isSfx = false;
  /** Bumped every time the voice is given a new sound; a stolen voice ignores a late release. */
  generation = 0;

  // state
  active = false;
  rt: InstRt | null = null;
  src = SRC_PULSE;
  note = 60;
  hz = 440;
  group = GROUP_NONE;
  quantMode = Q_NONE;
  quantLevels = 1;
  quantTable: Float32Array | null = null;
  gateMode = false;
  gate = 0;
  startFrame = 0;
  sidRouted = false;

  // envelope and gain
  readonly env: EnvelopeState = newEnvelope();
  ctl = 0;
  ctlTarget = 0;
  smooth: number;
  panTarget = 0;
  pan = 0;
  panL = Math.SQRT1_2;
  panR = Math.SQRT1_2;
  panTL = Math.SQRT1_2;
  panTR = Math.SQRT1_2;
  panStep: number;
  /** Running estimate of the source's DC level (asymmetric pulses, half sines, SID combinations), removed on linear buses. */
  dc = 0;
  /** Last mono sample this voice sent to its bus, and the decaying offset that hides a retrigger step. */
  private lastS = 0;
  private declickOff = 0;
  private declickPending = false;
  private readonly declickK: number;
  private readonly dcA: number;
  /** Send levels into the master effects. */
  sendEcho = 0;
  sendReverb = 0;

  // per-voice macro runtime
  readonly mVol: MacroRt = newMacroRt();
  readonly mArp: MacroRt = newMacroRt();
  readonly mPitch: MacroRt = newMacroRt();
  readonly mDuty: MacroRt = newMacroRt();
  readonly mPan: MacroRt = newMacroRt();

  // sources
  readonly ph: PhaseState = newPhase();
  readonly noise: NoiseState = newNoise();
  readonly sid: SidOsc = newSidOsc();
  readonly fm: FmState;
  fmRt: FmRt | null = null;
  sample: SampleRt | null = null;
  samplePos = 0;
  /** Frame of the last renderSample call at which a one shot sample ran out, or -1. */
  private sampleEndAt = -1;
  sampleStep = 0;
  duty = 0.5;
  wave: Float32Array = new Float32Array(32);
  noiseSeed = 1;
  noiseDirty = true;
  /** Genesis noise clocked by tone channel 3 (a sweepable rate) instead of one of the three fixed rates. */
  noiseTone3 = false;
  fmReleasing = false;

  // sfx program state
  prog: SfxProgram | null = null;
  readonly fx: SfxFx = newSfxFx();
  sfxFrame = 0;
  sfxRepeatFrame = 0;
  sfxAbs = 0;
  sfxReleased = false;
  sfxRelT = 0;
  sfxRelLevel = 0;
  sfxLastLevel = 0;
  sfxFinished = false;
  sfxPitch = 0;
  sfxVelocity = 1;
  lpCoef = 0;
  hpCoef = 0;
  phaserDelay = 0;
  phaserSign = 1;
  fmIndexNow = 0;

  // stolen voice fade
  stealLeft = 0;
  stealTotal = 0;
  pending: {
    prog: SfxProgram;
    velocity: number;
    pan: number;
    pitch: number;
    seed: number;
  } | null = null;
  /** The handle of the sfx sound this voice plays (or will play once a steal fade ends). */
  handle = 0;
  pendingRelease = false;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.smooth = 1 - Math.exp(-1 / (SMOOTH_SECONDS * sampleRate));
    this.panStep = 1 / (PAN_SECONDS * sampleRate);
    this.dcA = 1 - Math.exp((-2 * Math.PI * DC_HZ) / sampleRate);
    this.declickK = Math.exp(-1 / (DECLICK_SECONDS * sampleRate));
    this.fm = newFmState(sampleRate);
  }

  setChip(chip: ChipId): void {
    this.chip = chip;
    this.chipIdx = CHIP_INDEX[chip];
    this.profile = CHIPS[chip];
  }

  /** Pick volume quantization and the NES mixer group for the current chip and source. */
  private configureOutput(): void {
    const cons = this.profile.constraints;
    this.quantMode = Q_NONE;
    this.quantLevels = 1;
    this.quantTable = null;
    this.group = GROUP_NONE;
    this.gateMode = false;
    switch (this.chipIdx) {
      case CI_NES:
        this.quantMode = Q_LINEAR;
        this.quantLevels = cons.volumeSteps - 1;
        this.group = this.src === SRC_PULSE ? GROUP_PULSE : GROUP_TND;
        this.gateMode = this.src === SRC_TRI && cons.triangleSteps > 0;
        break;
      case CI_GB:
        this.quantMode = Q_LINEAR;
        this.quantLevels = cons.volumeSteps - 1;
        break;
      case CI_GENESIS:
        this.quantMode = Q_LOG;
        this.quantTable =
          this.src === SRC_FM ? logQuantTable(0.75, 128) : logQuantTable(2, 16);
        break;
      case CI_ADLIB:
        this.quantMode = Q_LOG;
        this.quantTable = logQuantTable(0.75, 64);
        break;
      case CI_C64:
        break;
      default:
        if (cons.volumeSteps > 0) {
          this.quantMode = Q_LINEAR;
          this.quantLevels = cons.volumeSteps - 1;
        }
        break;
    }
  }

  // ---------------------------------------------------------------- song notes

  /** Start a note of an instrument. note is a MIDI note; velocity scales the voice gain. */
  noteOn(rt: InstRt, note: number, frame: number): void {
    // a note that starts on a sounding voice restarts phases and envelopes, which steps the output: mixTo hides the
    // step with a short decaying offset
    this.declickPending = this.active && !this.isSfx;
    this.isSfx = false;
    this.prog = null;
    this.noiseTone3 = false;
    this.generation += 1;
    this.bindInstrument(rt, false);
    this.note = note;
    this.startFrame = frame;
    this.fmReleasing = false;
    this.configureOutput();
    this.ph.phase = 0;
    this.dc =
      this.src === SRC_PULSE
        ? 2 * this.duty - 1
        : this.src === SRC_WAVE
          ? meanOf(this.wave)
          : 0;
    if (this.src === SRC_NOISE) {
      this.initNoise(rt.noiseShort, this.noiseDirty);
    }
    if (this.src === SRC_FM && this.fmRt) {
      fmNoteOn(this.fm, this.fmRt, note);
    }
    if (this.src === SRC_SID) {
      this.sid.acc = 0;
      this.sid.active = true;
    }
    if (this.src === SRC_SAMPLE) {
      this.samplePos = 0;
      this.sampleEndAt = -1;
    }
    macroStart(this.mVol);
    macroStart(this.mArp);
    macroStart(this.mPitch);
    macroStart(this.mDuty);
    macroStart(this.mPan);
    envelopeTrigger(this.env);
    this.active = true;
    this.gate = this.gateMode ? this.gate : 1;
  }

  /** Bind the instrument's parameters. With carry, a live edit keeps the macro positions (macro index is kept when
      the new macro is at least as long). */
  bindInstrument(rt: InstRt, carry: boolean): void {
    const same = this.rt === rt;
    this.rt = rt;
    this.src = rt.src;
    this.duty = rt.duty;
    this.wave = rt.wave;
    this.sendEcho = rt.sendEcho;
    this.sendReverb = rt.sendReverb;
    this.fmRt = rt.fm;
    this.sample = rt.sample;
    if (this.src === SRC_FM) {
      setEnvelopeParams(this.env, MIN_ATTACK, 10, 1, 0.001, this.sr);
    } else {
      setEnvelopeParams(
        this.env,
        rt.attack,
        rt.decay,
        rt.sustain,
        rt.release,
        this.sr
      );
    }
    if (same) {
      return;
    }
    bindMacroKeep(this.mVol, rt.macroVolume, carry && this.active);
    bindMacroKeep(this.mArp, rt.macroArp, carry && this.active);
    bindMacroKeep(this.mPitch, rt.macroPitch, carry && this.active);
    bindMacroKeep(this.mDuty, rt.macroDuty, carry && this.active);
    bindMacroKeep(this.mPan, rt.macroPan, carry && this.active);
  }

  noteOff(): void {
    if (!this.active) {
      return;
    }
    macroRelease(this.mVol);
    macroRelease(this.mArp);
    macroRelease(this.mPitch);
    macroRelease(this.mDuty);
    macroRelease(this.mPan);
    if (this.src === SRC_FM) {
      fmNoteOff(this.fm);
      this.fmReleasing = true;
    } else {
      envelopeRelease(this.env);
    }
  }

  /** Cap the release at `seconds` (a pause: an instrument with a long release must not keep ringing). The envelope
      voices only; an FM voice keeps its operators' own release. The next note rebinds the instrument's release. */
  damp(seconds: number): void {
    if (this.active && this.src !== SRC_FM) {
      envelopeDamp(this.env, seconds, this.sr);
    }
  }

  /** Immediately silence the voice. */
  kill(): void {
    this.lastS = 0;
    this.declickOff = 0;
    this.declickPending = false;
    this.active = false;
    this.env.stage = ENV_IDLE;
    this.env.level = 0;
    this.sid.active = false;
    this.pending = null;
    this.stealLeft = 0;
    if (this.fmRt) {
      fmReset(this.fm);
    }
  }

  tickMacros(): void {
    if (this.mVol.present) {
      macroTick(this.mVol);
    }
    if (this.mArp.present) {
      macroTick(this.mArp);
    }
    if (this.mPitch.present) {
      macroTick(this.mPitch);
    }
    if (this.mDuty.present) {
      macroTick(this.mDuty);
    }
    if (this.mPan.present) {
      macroTick(this.mPan);
    }
  }

  /** Pick the LFSR model for the chip. The register is only reseeded when the seed is fresh (song start, sfx trigger),
      so successive drum hits continue the sequence the way the hardware register keeps running. */
  private initNoise(short: boolean, reseed: boolean): void {
    const n = this.noise;
    let mode: number;
    switch (this.chipIdx) {
      case CI_NES:
        mode = short ? NOISE_NES_SHORT : NOISE_NES_LONG;
        break;
      case CI_GB:
        mode = short ? NOISE_GB_SHORT : NOISE_GB_LONG;
        break;
      case CI_GENESIS:
        mode = short ? NOISE_PSG_PERIODIC : NOISE_PSG_WHITE;
        break;
      default:
        mode = short ? NOISE_NES_SHORT : NOISE_WHITE;
        break;
    }
    if (reseed) {
      seedNoise(n, mode, this.noiseSeed);
      this.noiseDirty = false;
    } else {
      n.mode = mode;
    }
  }

  // ---------------------------------------------------------------- pitch, gain, pan

  /** Set the pitch from a (fractional) MIDI note. */
  setNote(note: number): void {
    this.applyHz(noteToHz(note));
  }

  /** The frequency a chip's period register can reach for a pulse, triangle or wave channel. */
  private periodHz(hz: number): number {
    switch (this.chipIdx) {
      case CI_NES:
        return this.src === SRC_TRI
          ? nesQuantizeTriangleHz(hz)
          : nesQuantizePulseHz(hz);
      case CI_GB:
        return this.src === SRC_WAVE
          ? gbQuantizeWaveHz(hz)
          : gbQuantizePulseHz(hz);
      case CI_GENESIS:
        return genesisQuantizeHz(hz);
      case CI_C64:
        return c64QuantizeHz(hz);
      default:
        return hz;
    }
  }

  /** LFSR steps per second for a noise channel: the chip's own rate table where it has one. */
  private noiseRate(hz: number, period: boolean): number {
    if (period && this.chipIdx === CI_NES) {
      return nesQuantizeNoiseRate(hz);
    }
    if (period && this.chipIdx === CI_GB) {
      return gbQuantizeNoiseRate(hz);
    }
    if (period && this.chipIdx === CI_GENESIS) {
      return this.noiseTone3
        ? genesisQuantizeTone3Rate(hz)
        : genesisQuantizeNoiseRate(hz);
    }
    return Math.min(1_000_000, Math.max(1, hz) * 16);
  }

  /** Quantize a requested frequency to what the chip can play and program the source. */
  applyHz(hz: number): void {
    const sr = this.sr;
    const period = this.profile.constraints.pitch === "period";
    let h = hz;
    switch (this.src) {
      case SRC_PULSE:
      case SRC_TRI:
      case SRC_WAVE:
        h = period ? this.periodHz(hz) : hz;
        this.ph.dt = Math.min(MAX_DT, h / sr);
        break;
      case SRC_SAW:
      case SRC_SINE:
        h = period && this.chipIdx === CI_C64 ? c64QuantizeHz(hz) : hz;
        this.ph.dt = Math.min(MAX_DT, h / sr);
        break;
      case SRC_NOISE:
        this.noise.stepsPerSample = this.noiseRate(hz, period) / sr;
        break;
      case SRC_SID: {
        const f = c64HzToPeriod(hz);
        sidSetRate(this.sid, f, C64_CLOCK_HZ, sr);
        h = c64PeriodToHz(f);
        break;
      }
      case SRC_FM:
        if (this.fmRt) {
          fmSetPitch(this.fm, this.fmRt, hz, this.fm.lfoPitch);
        }
        break;
      case SRC_SAMPLE:
        if (this.sample) {
          const base = noteToHz(this.sample.baseNote);
          this.sampleStep = (hz / base) * (this.sample.rate / sr);
        }
        break;
      default:
        break;
    }
    this.hz = h;
  }

  /** Target gain for everything except the envelope. The voice smooths towards it. */
  setGain(g: number, immediate: boolean): void {
    this.ctlTarget = g;
    if (immediate) {
      this.ctl = g;
    }
  }

  /** Pan -1..1, snapped per chip pan mode. */
  setPan(p: number, immediate: boolean): void {
    let v = Math.min(1, Math.max(-1, p));
    const mode = this.profile.constraints.pan;
    if (mode === "none") {
      v = 0;
    } else if (mode === "hard") {
      v = v < -0.33 ? -1 : v > 0.33 ? 1 : 0;
    }
    this.panTarget = v;
    const ang = (v + 1) * 0.25 * Math.PI;
    this.panTL = Math.cos(ang);
    this.panTR = Math.sin(ang);
    if (immediate) {
      this.pan = v;
      this.panL = this.panTL;
      this.panR = this.panTR;
    }
  }

  setDuty(d: number): void {
    if (this.src === SRC_PULSE) {
      // the pulse's DC level moves with its width: shift the tracker so a duty change does not thump
      this.dc += 2 * (d - this.duty);
    }
    this.duty = d;
  }

  /** SID waveform mask, ring, sync and pulse width. */
  setSid(mask: number, pw: number, ring: boolean, sync: boolean): void {
    const o = this.sid;
    o.mask = mask;
    o.pw12 = Math.min(4095, Math.max(0, Math.round(pw * 4096)));
    o.ring = ring;
    o.sync = sync;
  }

  setFmAlgorithm(alg: number): void {
    if (this.fmRt) {
      fmSetAlgorithm(this.fm, this.fmRt, alg);
    }
  }

  // ---------------------------------------------------------------- sfx

  startSfx(
    prog: SfxProgram,
    velocity: number,
    pan: number,
    pitch: number,
    seed: number
  ): void {
    this.isSfx = true;
    this.rt = null;
    this.prog = prog;
    this.generation += 1;
    this.setChip(prog.chip);
    this.src = prog.src;
    this.noiseTone3 = prog.noiseTone3;
    this.sfxFrame = 0;
    this.sfxRepeatFrame = 0;
    this.sfxAbs = 0;
    this.sfxReleased = false;
    this.sfxFinished = false;
    this.sfxPitch = pitch;
    this.sfxVelocity = velocity;
    this.sfxLastLevel = 0;
    this.noiseSeed = seed;
    this.fmRt = null;
    this.mVol.present = false;
    this.mArp.present = false;
    this.mPitch.present = false;
    this.mDuty.present = false;
    this.mPan.present = false;
    this.wave = prog.table;
    this.configureOutput();
    this.ph.phase = 0;
    this.dc = 0;
    resetSfxFx(this.fx);
    this.lpCoef = 0;
    this.hpCoef = 0;
    if (this.src === SRC_NOISE) {
      this.initNoise(prog.noiseShort, true);
    }
    if (this.src === SRC_FM) {
      this.fm.phase.fill(0);
      this.fm.out1.fill(0);
      this.fm.out2.fill(0);
    }
    this.env.stage = ENV_SUSTAIN;
    this.env.level = 1;
    this.setGain(prog.volume * velocity, true);
    this.setPan(pan, true);
    this.sendEcho = 0;
    this.sendReverb = 0;
    this.active = true;
    this.stealLeft = 0;
    this.pending = null;
    this.gate = 1;
    if (this.pendingRelease) {
      this.pendingRelease = false;
      this.releaseSfx();
    }
  }

  /** Steal this voice for a new sfx: fade the old sound out over 2 ms, then start the new program. */
  stealFor(
    prog: SfxProgram,
    velocity: number,
    pan: number,
    pitch: number,
    seed: number
  ): void {
    this.pending = { pan, pitch, prog, seed, velocity };
    this.pendingRelease = false;
    this.stealTotal = Math.max(1, Math.round(STEAL_SECONDS * this.sr));
    this.stealLeft = this.stealTotal;
  }

  releaseSfx(): void {
    if (this.pending) {
      this.pendingRelease = true;
      return;
    }
    if (this.isSfx && this.active && !this.sfxReleased) {
      this.sfxReleased = true;
      this.sfxRelT = 0;
      this.sfxRelLevel = this.sfxLastLevel;
    }
  }

  /** The sfx pitch at repeat-relative time t: slide, pitch offset, vibrato and arpeggio. Ends the sound below `min`. */
  private sfxHz(p: SfxProgram, t: number): number {
    const octaves = p.slide * t + 0.5 * p.deltaSlide * t * t;
    let hz = p.startHz * 2 ** (octaves + this.sfxPitch / 12);
    if (p.vibRate > 0 && p.vibDepth > 0) {
      hz *= 2 ** ((p.vibDepth * Math.sin(2 * Math.PI * p.vibRate * t)) / 12);
    }
    if (p.arpRate > 0) {
      const idx = Math.floor(t * p.arpRate) % p.arpSteps.length;
      hz *= 2 ** ((p.arpSteps[idx] ?? 0) / 12);
    }
    if (p.minHz > 0 && hz < p.minHz) {
      this.sfxFinished = true;
    }
    return Math.min(20_000, Math.max(8, hz));
  }

  /** Program the source for an sfx pitch. FM sfx put the carrier at hz and the modulator at hz * ratio, index decaying.
      The sfx index is the peak phase deviation in radians (the sfxr-like "amount of modulation"); the voice
      keeps it in cycles, which is what the sine lookup takes. */
  private applySfxPitch(p: SfxProgram, hz: number, t: number): void {
    if (this.src !== SRC_FM) {
      this.applyHz(hz);
      return;
    }
    const sr = this.sr;
    const f = this.fm;
    const index =
      p.fmIndexDecay > 0
        ? p.fmIndex * Math.max(0, 1 - t / p.fmIndexDecay)
        : p.fmIndex;
    this.fmIndexNow = index / TWO_PI;
    f.inc[0] = Math.min(0.49, (hz * p.fmRatio) / sr);
    f.inc[1] = Math.min(0.49, hz / sr);
  }

  /** The pulse width at time t, snapped to the chip's duty cycles when it has a fixed set. */
  private applySfxDuty(p: SfxProgram, t: number): void {
    const d = Math.min(1, Math.max(0, p.dutyStart + p.dutySweep * t));
    const list = this.profile.constraints.dutyCycles;
    this.setDuty(list.length > 0 ? nearest(list, d) : d);
  }

  /** One pole low pass and high pass coefficients (0 when the filter is off) and the phaser delay at time t. */
  private applySfxFilters(p: SfxProgram, t: number): void {
    const sr = this.sr;
    this.lpCoef =
      p.lowpass > 0
        ? onePoleCoef(
            Math.min(
              20_000,
              Math.max(50, p.lowpass * 2 ** (p.lowpassSweep * t))
            ),
            sr
          )
        : 0;
    this.hpCoef =
      p.highpass > 0
        ? onePoleCoef(
            Math.min(
              10_000,
              Math.max(20, p.highpass * 2 ** (p.highpassSweep * t))
            ),
            sr
          )
        : 0;
    if (p.phaserOffsetMs !== 0 || p.phaserSweep !== 0) {
      const ms = p.phaserOffsetMs + p.phaserSweep * t;
      this.phaserDelay = (Math.abs(ms) * sr) / 1000;
      this.phaserSign = ms < 0 ? -1 : 1;
    } else {
      this.phaserDelay = -1;
    }
  }

  /** Per-segment sfx program control: pitch, duty, filter coefficients, phaser. t is the repeat-relative time. */
  private sfxControl(): void {
    const p = this.prog;
    if (!p) {
      return;
    }
    const t = (this.sfxRepeatFrame + SFX_CTRL * 0.5) / this.sr;
    this.applySfxPitch(p, this.sfxHz(p, t), t);
    if (this.src === SRC_PULSE) {
      this.applySfxDuty(p, t);
    }
    this.applySfxFilters(p, t);
  }

  /** Sfx envelope: attack, sustain with punch, linear decay. Writes the level per sample. */
  private sfxEnvelope(out: Float32Array, n: number): void {
    const p = this.prog;
    if (!p) {
      out.fill(0, 0, n);
      return;
    }
    const sr = this.sr;
    const declick = Math.max(1, Math.round(MIN_ATTACK * sr));
    const endFade = Math.max(1, Math.round(SFX_END_FADE * sr));
    const a = p.attackFrames;
    const s = p.sustainFrames;
    const d = p.decayFrames;
    for (let i = 0; i < n; i += 1) {
      let lvl: number;
      const t = this.sfxFrame;
      if (this.sfxReleased) {
        lvl = this.sfxRelLevel * (1 - this.sfxRelT / d);
        this.sfxRelT += 1;
        if (this.sfxRelT >= d) {
          this.sfxFinished = true;
        }
      } else if (t < a) {
        lvl = (t + 1) / a;
      } else if (t < a + s) {
        lvl = 1 + p.punch * (1 - (t - a) / s);
      } else if (t < a + s + d) {
        lvl = 1 - (t - a - s) / d;
      } else {
        lvl = 0;
      }
      // declick at the start of every repeat
      if (this.sfxRepeatFrame < declick) {
        lvl *= (this.sfxRepeatFrame + 1) / declick;
      }
      // the whole sound ends at its total length even when repeats restart the envelope
      const left = p.totalFrames - this.sfxAbs;
      if (left < endFade) {
        lvl *= Math.max(0, left / endFade);
      }
      if (this.sfxAbs >= p.totalFrames) {
        this.sfxFinished = true;
        lvl = 0;
      }
      this.sfxLastLevel = lvl;
      out[i] = lvl < 0 ? 0 : lvl;
      this.sfxFrame += 1;
      this.sfxAbs += 1;
      this.sfxRepeatFrame += 1;
      if (p.repeatFrames > 0 && this.sfxRepeatFrame >= p.repeatFrames) {
        this.sfxRepeatFrame = 0;
        this.sfxFrame = 0;
        this.sfxRelT = 0;
      }
    }
  }

  // ---------------------------------------------------------------- render

  /** Render n frames (n <= BLOCK) into xbuf (source) and gbuf (amplitude). Returns whether the voice is still active.
      With externalSource the caller has already put the source signal into xbuf (SID voices). */
  render(n: number, externalSource: boolean): boolean {
    if (!this.active) {
      this.xbuf.fill(0, 0, n);
      this.gbuf.fill(0, 0, n);
      return false;
    }
    if (this.stealLeft > 0 && this.pending) {
      return this.renderStolen(n);
    }
    this.renderPart(n, externalSource, 0);
    if (this.active || n === 0) {
      return this.active;
    }
    return false;
  }

  private renderStolen(n: number): boolean {
    const take = Math.min(n, this.stealLeft);
    this.renderPart(take, false, 0);
    const total = this.stealTotal;
    for (let i = 0; i < take; i += 1) {
      this.gbuf[i] = (this.gbuf[i] ?? 0) * ((this.stealLeft - i) / total);
    }
    this.stealLeft -= take;
    if (this.stealLeft <= 0 && this.pending) {
      const q = this.pending;
      this.startSfx(q.prog, q.velocity, q.pan, q.pitch, q.seed);
      const rest = n - take;
      if (rest > 0) {
        this.renderPart(rest, false, take);
      }
    } else if (take < n) {
      this.xbuf.fill(0, take, n);
      this.gbuf.fill(0, take, n);
    }
    return true;
  }

  /** Render n frames into xbuf and gbuf starting at off. Sfx voices are split on their own control grid. */
  private renderPart(n: number, externalSource: boolean, off: number): void {
    if (!(this.isSfx && this.prog)) {
      this.renderChunk(n, externalSource, off);
      return;
    }
    const p = this.prog;
    let done = 0;
    while (done < n) {
      const abs = this.sfxAbs;
      let chunk = Math.min(n - done, SFX_CTRL - (abs % SFX_CTRL));
      if (p.repeatFrames > 0) {
        chunk = Math.min(
          chunk,
          Math.max(1, p.repeatFrames - this.sfxRepeatFrame)
        );
      }
      if (abs % SFX_CTRL === 0 || this.sfxRepeatFrame === 0) {
        this.sfxControl();
      }
      this.renderChunk(chunk, false, off + done);
      done += chunk;
      if (!this.active) {
        break;
      }
    }
    if (done < n) {
      this.xbuf.fill(0, off + done, off + n);
      this.gbuf.fill(0, off + done, off + n);
    }
  }

  private renderChunk(n: number, externalSource: boolean, off: number): void {
    const x = externalSource ? this.xbuf : this.wx;
    // 1. source. A song noise voice keeps its LFSR running between notes, so the register must stop at the frame where
    // the envelope falls idle, not at the end of whatever block the host happened to use.
    const keepLfsr = this.src === SRC_NOISE && !this.isSfx && !externalSource;
    let lfsr = 0;
    let lacc = 0;
    let llast = 0;
    if (keepLfsr) {
      lfsr = this.noise.lfsr;
      lacc = this.noise.acc;
      llast = this.noise.last;
    }
    if (!externalSource) {
      this.renderSource(x, n);
    }
    // 2. sfx effects
    if (this.isSfx && this.prog) {
      const p = this.prog;
      if (this.lpCoef > 0) {
        runLowpass(this.fx, x, n, this.lpCoef, p.resonance);
      }
      if (this.hpCoef > 0) {
        runHighpass(this.fx, x, n, this.hpCoef);
      }
      if (this.phaserDelay >= 0) {
        runPhaser(this.fx, x, n, this.phaserDelay, this.phaserSign);
      }
      if (p.bits > 0 || p.rateDivide > 1) {
        runBitcrush(this.fx, x, n, p.bits, p.rateDivide);
      }
    }
    // 3. envelope
    const e = this.ebuf;
    if (this.isSfx) {
      this.sfxEnvelope(e, n);
    } else {
      runEnvelope(this.env, e, n);
      if (keepLfsr && this.env.idleAt >= 0 && this.env.idleAt < n) {
        const nz = this.noise;
        nz.lfsr = lfsr;
        nz.acc = lacc;
        nz.last = llast;
        renderNoise(nz, NOISE_SCRATCH, this.env.idleAt);
      }
    }
    // 4. amplitude: smoothed control gain, gate or stepped volume
    this.amplitude(n);
    const wx = this.wx;
    const wg = this.wg;
    const xbuf = this.xbuf;
    const gbuf = this.gbuf;
    if (externalSource) {
      for (let i = 0; i < n; i += 1) {
        gbuf[off + i] = wg[i] ?? 0;
      }
    } else {
      for (let i = 0; i < n; i += 1) {
        xbuf[off + i] = wx[i] ?? 0;
        gbuf[off + i] = wg[i] ?? 0;
      }
    }
    // 5. voice end. A one shot sample falls silent at its exact last frame, whatever the block size.
    if (this.sampleEndAt >= 0 && !this.isSfx) {
      this.wg.fill(0, this.sampleEndAt, n);
      this.gbuf.fill(0, off + this.sampleEndAt, off + n);
      this.sampleEndAt = -1;
      this.active = false;
    }
    if (
      this.src === SRC_SID &&
      this.sid.active &&
      !this.isSfx &&
      this.env.stage === ENV_IDLE
    ) {
      this.sid.active = false;
    }
    if (this.isSfx) {
      if (this.sfxFinished) {
        this.active = false;
      }
    } else if (this.src === SRC_FM) {
      if (this.fmReleasing && fmSilent(this.fm)) {
        this.active = false;
      }
    } else if (this.env.stage === ENV_IDLE) {
      this.active = false;
    } else if (
      this.src === SRC_SAMPLE &&
      this.sample &&
      !this.sample.loops &&
      this.samplePos >= this.sample.data.length
    ) {
      this.active = false;
    }
  }

  private amplitude(n: number): void {
    const e = this.ebuf;
    const g = this.wg;
    const k = this.smooth;
    let ctl = this.ctl;
    const target = this.ctlTarget;
    const mode = this.quantMode;
    const levels = this.quantLevels;
    const table = this.quantTable;
    const gateMode = this.gateMode;
    let gate = this.gate;
    const slew = 1 / Math.max(1, MIN_ATTACK * this.sr);
    for (let i = 0; i < n; i += 1) {
      ctl += (target - ctl) * k;
      if (Math.abs(target - ctl) < 1e-6) {
        ctl = target;
      }
      let a = (e[i] ?? 0) * ctl;
      if (gateMode) {
        const want = a > 0.5 ? 1 : 0;
        gate += Math.max(-slew, Math.min(slew, want - gate));
        a = gate;
      } else if (mode === Q_LINEAR) {
        a = a > 1 ? 1 : Math.round(a * levels) / levels;
      } else if (mode === Q_LOG && table) {
        const idx = a >= 1 ? QUANT_RES : Math.floor(a * QUANT_RES + 0.5);
        a = table[idx > QUANT_RES ? QUANT_RES : idx] ?? 0;
      }
      g[i] = a;
    }
    this.ctl = ctl;
    this.gate = gate;
  }

  /** Rough current loudness, used to pick which sfx voice to steal. */
  currentLevel(): number {
    return this.isSfx
      ? this.sfxLastLevel * this.ctl
      : this.env.level * this.ctl;
  }

  /** Mix the last rendered n frames into the chip bus, the scope stem and the master effect sends. When sidIn is
      given the voice is routed through the shared SID filter and only adds its mono signal there. */
  mixTo(
    n: number,
    bus: ChipBus,
    stem: Float32Array | null,
    sinks: MixSinks,
    sidIn: Float32Array | null
  ): void {
    const x = this.xbuf;
    const g = this.gbuf;
    const group = this.group;
    const triGroup = this.src === SRC_TRI;
    let pl = this.panL;
    let pr = this.panR;
    const tl = this.panTL;
    const tr = this.panTR;
    const step = this.panStep;
    const se = sinks.enabled ? this.sendEcho : 0;
    const sv = sinks.enabled ? this.sendReverb : 0;
    const sends = se > 0 || sv > 0;
    if (sidIn === null) {
      bus.touch(n);
    }
    const linear = group === GROUP_NONE;
    const dcA = this.dcA;
    let dc = this.dc;
    let off = this.declickOff;
    let pend = this.declickPending;
    const last = this.lastS;
    const decay = this.declickK;
    let lastOut = 0;
    for (let i = 0; i < n; i += 1) {
      const xv = x[i] ?? 0;
      const gv = g[i] ?? 0;
      let s: number;
      if (linear) {
        dc += (xv - dc) * dcA;
        s = (xv - dc) * gv;
        if (pend) {
          off = last - s;
          pend = false;
        }
        s += off;
        off = off < 1e-9 && off > -1e-9 ? 0 : off * decay;
        lastOut = s;
      } else {
        s = xv * gv;
      }
      if (stem) {
        stem[i] = s;
      }
      if (pl !== tl) {
        const d = tl - pl;
        pl = d > step ? pl + step : d < -step ? pl - step : tl;
      }
      if (pr !== tr) {
        const d = tr - pr;
        pr = d > step ? pr + step : d < -step ? pr - step : tr;
      }
      if (sidIn !== null) {
        sidIn[i] = (sidIn[i] ?? 0) + s;
      } else if (group === GROUP_PULSE || group === GROUP_TND) {
        // NES groups: the declick offset lives in the 0..15 level units the mixer takes
        let u = (xv * 0.5 + 0.5) * gv * 15;
        if (pend) {
          off = last - u;
          pend = false;
        }
        u += off;
        off = off < 1e-9 && off > -1e-9 ? 0 : off * decay;
        lastOut = u;
        if (group === GROUP_PULSE) {
          bus.pulse[i] = (bus.pulse[i] ?? 0) + u;
          bus.pulseMid[i] = (bus.pulseMid[i] ?? 0) + this.duty * gv * 15;
        } else if (triGroup) {
          bus.tri[i] = (bus.tri[i] ?? 0) + u;
          bus.triMid[i] = (bus.triMid[i] ?? 0) + gv * 7.5;
        } else {
          bus.noise[i] = (bus.noise[i] ?? 0) + u;
          bus.noiseMid[i] = (bus.noiseMid[i] ?? 0) + gv * 7.5;
        }
      } else {
        bus.l[i] = (bus.l[i] ?? 0) + s * pl;
        bus.r[i] = (bus.r[i] ?? 0) + s * pr;
      }
      if (sends) {
        sinks.echoL[i] = (sinks.echoL[i] ?? 0) + s * se * pl;
        sinks.echoR[i] = (sinks.echoR[i] ?? 0) + s * se * pr;
        sinks.revL[i] = (sinks.revL[i] ?? 0) + s * sv * pl;
        sinks.revR[i] = (sinks.revR[i] ?? 0) + s * sv * pr;
      }
    }
    this.panL = pl;
    this.panR = pr;
    this.dc = dc;
    this.declickPending = pend;
    this.declickOff = off;
    this.lastS = lastOut;
  }

  private renderSource(x: Float32Array, n: number): void {
    switch (this.src) {
      case SRC_PULSE:
        renderPulse(this.ph, this.duty, x, n);
        break;
      case SRC_TRI:
        if (this.profile.constraints.triangleSteps > 0) {
          renderStepped(this.ph, nesTriangleTable(), x, n);
        } else {
          renderTriangle(this.ph, x, n);
        }
        break;
      case SRC_SAW:
        renderSaw(this.ph, x, n);
        break;
      case SRC_SINE:
        renderSine(this.ph, sineTable(), x, n);
        break;
      case SRC_WAVE:
        renderStepped(this.ph, this.wave, x, n);
        break;
      case SRC_NOISE:
        renderNoise(this.noise, x, n);
        break;
      case SRC_FM:
        if (this.isSfx) {
          this.renderSfxFm(x, n);
        } else {
          renderFm(this.fm, x, n);
        }
        break;
      case SRC_SAMPLE:
        this.renderSample(x, n);
        break;
      default:
        x.fill(0, 0, n);
        break;
    }
  }

  /** Sfx "fm" wave: a 2-operator patch from ratio, index and index decay. */
  private renderSfxFm(x: Float32Array, n: number): void {
    const f = this.fm;
    const sine = sineTable();
    const cycles = this.fmIndexNow;
    let pm = f.phase[0] ?? 0;
    let pc = f.phase[1] ?? 0;
    const im = f.inc[0] ?? 0;
    const ic = f.inc[1] ?? 0;
    for (let i = 0; i < n; i += 1) {
      const m = sineAt(sine, pm);
      const c = sineAt(sine, pc + m * cycles);
      x[i] = c;
      pm += im;
      if (pm >= 1) {
        pm -= 1;
      }
      pc += ic;
      if (pc >= 1) {
        pc -= 1;
      }
    }
    f.phase[0] = pm;
    f.phase[1] = pc;
  }

  private renderSample(x: Float32Array, n: number): void {
    const s = this.sample;
    if (!s) {
      x.fill(0, 0, n);
      return;
    }
    const data = s.data;
    const len = data.length;
    let pos = this.samplePos;
    const step = this.sampleStep;
    for (let i = 0; i < n; i += 1) {
      if (s.loops && pos >= s.loopEnd) {
        pos = s.loopStart + (pos - s.loopEnd);
      }
      if (pos >= len - 1) {
        x[i] = 0;
        pos += step;
        if (!s.loops && this.sampleEndAt < 0) {
          this.sampleEndAt = i;
        }
        continue;
      }
      const k = Math.floor(pos);
      const fr = pos - k;
      const a = data[k] ?? 0;
      const b = data[k + 1] ?? 0;
      x[i] = a + (b - a) * fr;
      pos += step;
    }
    this.samplePos = pos;
  }
}

function meanOf(a: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += a[i] ?? 0;
  }
  return a.length > 0 ? sum / a.length : 0;
}

function bindMacroKeep(dst: MacroRt, src: MacroRt, keep: boolean): void {
  if (!(keep && dst.present)) {
    macroBind(dst, src);
    return;
  }
  const idx = dst.idx;
  const released = dst.released;
  macroBind(dst, src);
  if (src.present) {
    dst.released = released;
    dst.idx =
      idx < src.values.length ? idx : Math.max(0, src.values.length - 1);
    dst.value = src.values[dst.idx] ?? 0;
  }
}

function sineAt(table: Float32Array, phase: number): number {
  const ph = phase - Math.floor(phase);
  const p = ph * 4096;
  const i = Math.floor(p);
  const a = table[i] ?? 0;
  const b = table[i + 1] ?? 0;
  return a + (b - a) * (p - i);
}
