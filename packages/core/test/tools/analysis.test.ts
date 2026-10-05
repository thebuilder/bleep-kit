import { describe, expect, it } from "vitest";
import { analyze } from "../../src/tools/analysis.ts";
import { dbToAmp, noise, pulse, render, sine } from "./helpers.ts";

const SR = 48_000;

describe("analyze", () => {
  it("measures a 440 Hz sine at -6 dBFS", () => {
    const a = analyze(render(SR, sine(SR, 1, 440, dbToAmp(-6))), {
      file: "sine.wav",
    });
    expect(a.file).toBe("sine.wav");
    expect(a.sampleRate).toBe(SR);
    expect(a.channels).toBe(2);
    expect(a.frames).toBe(SR);
    expect(a.duration).toBe(1);
    expect(a.peakDb).toBeCloseTo(-6, 1);
    expect(a.rmsDb).toBeCloseTo(-9, 1);
    expect(a.crestDb).toBeCloseTo(3.01, 1);
    expect(Math.abs((a.pitch.medianHz ?? 0) - 440)).toBeLessThan(1);
    expect(a.pitch.medianNote).toBe("A-4");
    expect(a.clipped).toEqual({ first: null, frames: 0 });
    expect(Math.abs(a.dcOffset)).toBeLessThan(1e-4);
    expect(a.loop).toBeNull();
    expect(a.dutyCycle).toBeNull();
  });

  it("puts the spectral centroid and band levels where the tone is", () => {
    const a = analyze(render(SR, sine(SR, 1, 1000, 0.5)));
    expect(Math.abs(a.spectrum.centroidHz - 1000)).toBeLessThan(30);
    expect(a.spectrum.bands.midDb).toBeCloseTo(a.rmsDb, 0);
    expect(a.spectrum.bands.lowDb).toBeLessThan(-60);
    expect(a.spectrum.bands.highDb).toBeLessThan(-60);
    const high = analyze(render(SR, sine(SR, 1, 9000, 0.5)));
    expect(high.spectrum.bands.highDb).toBeCloseTo(high.rmsDb, 0);
    const low = analyze(render(SR, sine(SR, 1, 100, 0.5)));
    expect(low.spectrum.bands.lowDb).toBeCloseTo(low.rmsDb, 0);
  });

  it("measures K-weighted loudness: stereo 1 kHz at -20 dBFS reads about -20 LUFS", () => {
    const a = analyze(render(SR, sine(SR, 3, 1000, dbToAmp(-20))));
    expect(a.lufs).toBeCloseTo(-20, 0);
  });

  it("weights low frequencies down in LUFS", () => {
    const mid = analyze(render(SR, sine(SR, 3, 1000, 0.3))).lufs;
    const bass = analyze(render(SR, sine(SR, 3, 40, 0.3))).lufs;
    expect(mid - bass).toBeGreaterThan(1.5);
  });

  it("gates silence out of the integrated loudness", () => {
    const loud = sine(SR, 2, 1000, 0.25);
    const padded = new Float32Array(SR * 6);
    padded.set(loud, 0);
    const whole = analyze(render(SR, loud)).lufs;
    expect(analyze(render(SR, padded)).lufs).toBeCloseTo(whole, 0);
  });

  it("measures material shorter than one loudness block", () => {
    const a = analyze(render(SR, sine(SR, 0.1, 1000, 0.5)));
    expect(a.lufs).toBeGreaterThan(-20);
    expect(a.lufs).toBeLessThan(0);
  });

  it("counts clipped frames and reports the first as a frame index", () => {
    const s = sine(SR, 0.5, 440, 0.5);
    s[1000] = 1;
    s[1001] = -1;
    s[5000] = 0.9995;
    const a = analyze(render(SR, s, new Float32Array(s.length)));
    expect(a.clipped.frames).toBe(3);
    expect(a.clipped.first).toBe(1000);
    expect(a.peakDb).toBeCloseTo(0, 1);
  });

  it("reads a DC offset", () => {
    const s = sine(SR, 1, 440, 0.2);
    for (let i = 0; i < s.length; i += 1) {
      s[i] = (s[i] ?? 0) + 0.1;
    }
    expect(analyze(render(SR, s)).dcOffset).toBeCloseTo(0.1, 4);
  });

  it("finds leading and trailing silence and the quietest window", () => {
    const body = sine(SR, 0.5, 440, 0.5);
    const s = new Float32Array(SR * 1);
    s.set(body, Math.round(SR * 0.25));
    const a = analyze(render(SR, s));
    expect(a.leadingSilence).toBeCloseTo(0.25, 2);
    expect(a.trailingSilence).toBeCloseTo(0.25, 2);
    expect(a.silenceDb).toBe(-120);
  });

  it("calls an all zero file silent", () => {
    const a = analyze(render(SR, new Float32Array(SR / 2)));
    expect(a.peakDb).toBe(-120);
    expect(a.rmsDb).toBe(-120);
    expect(a.lufs).toBe(-120);
    expect(a.leadingSilence).toBeCloseTo(0.5, 6);
    expect(a.trailingSilence).toBeCloseTo(0.5, 6);
    expect(a.spectrum.centroidHz).toBe(0);
    expect(a.pitch.medianHz).toBeNull();
  });

  it("handles an empty render", () => {
    const a = analyze(render(SR, new Float32Array(0)));
    expect(a.frames).toBe(0);
    expect(a.duration).toBe(0);
    expect(a.envelope).toEqual([]);
    expect(a.peakDb).toBe(-120);
  });

  it("reports mono files as one channel", () => {
    const left = sine(SR, 0.3, 440, 0.5);
    const a = analyze({
      channels: [left],
      events: [],
      frames: left.length,
      sampleRate: SR,
    });
    expect(a.channels).toBe(1);
    expect(a.rmsDb).toBeCloseTo(-9.03, 1);
  });

  describe("loop seam", () => {
    it("reads zero difference for a seamless periodic loop", () => {
      // a 100 Hz sine has a 480 frame period, so loops cut on whole periods repeat exactly
      const s = sine(SR, 2, 100, 0.5);
      const a = analyze(
        render(SR, s, s, { loopEnd: 480 * 150, loopStart: 480 * 30 })
      );
      expect(a.loop?.start).toBeCloseTo((480 * 30) / SR, 4);
      expect(a.loop?.end).toBeCloseTo((480 * 150) / SR, 4);
      expect(a.loop?.seamDiffDb ?? 0).toBeLessThan(-60);
    });

    it("sees a mismatched seam", () => {
      const s = sine(SR, 2, 100, 0.5);
      const a = analyze(
        render(SR, s, s, { loopEnd: 480 * 150 + 120, loopStart: 480 * 30 })
      );
      expect(a.loop?.seamDiffDb ?? -120).toBeGreaterThan(-12);
    });

    it("has no seam reading when the loop starts too early to look back from, or ends past the file", () => {
      const s = sine(SR, 2, 100, 0.5);
      const early = analyze(
        render(SR, s, s, { loopEnd: 480 * 150, loopStart: 0 })
      );
      expect(early.loop?.seamDiffDb).toBeNull();
      expect(early.loop?.start).toBe(0);
      const short = analyze(
        render(SR, s, s, { loopEnd: 480 * 150, loopStart: 24 })
      );
      expect(short.loop?.seamDiffDb).toBeNull();
      const past = analyze(
        render(SR, s, s, { loopEnd: SR * 3, loopStart: 480 * 30 })
      );
      expect(past.loop?.seamDiffDb).toBeNull();
    });

    it("is null without loop points", () => {
      expect(analyze(render(SR, sine(SR, 0.5, 100, 0.5))).loop).toBeNull();
    });
  });

  describe("pitch and envelope", () => {
    it("trims the pitch track to 200 entries by default and keeps all when asked", () => {
      const s = sine(SR, 3, 440, 0.5);
      const trimmed = analyze(render(SR, s));
      expect(trimmed.pitch.track).toHaveLength(200);
      expect(trimmed.pitch.track[0]?.time).toBeLessThan(0.1);
      expect(trimmed.pitch.track.at(-1)?.time ?? 0).toBeGreaterThan(2.7);
      const full = analyze(render(SR, s), {
        maxTrack: Number.POSITIVE_INFINITY,
      });
      expect(full.pitch.track.length).toBeGreaterThan(250);
      expect(analyze(render(SR, s), { maxTrack: 20 }).pitch.track).toHaveLength(
        20
      );
    });

    it("gives an RMS envelope every 10 ms", () => {
      const a = analyze(render(SR, sine(SR, 1, 440, dbToAmp(-6))));
      expect(a.envelope).toHaveLength(100);
      expect(a.envelope[1]?.time).toBeCloseTo(0.01, 6);
      for (const p of a.envelope) {
        expect(p.db).toBeCloseTo(-9, 0);
      }
    });

    it("widens the envelope step to keep at most 1000 points", () => {
      const a = analyze(render(SR, noise(SR, 11, 0.3)));
      expect(a.envelope.length).toBeLessThanOrEqual(1000);
      expect(a.envelope.length).toBeGreaterThan(900);
    });

    it("follows a decay", () => {
      const s = sine(SR, 1, 440, 0.8);
      for (let i = 0; i < s.length; i += 1) {
        s[i] = (s[i] ?? 0) * (1 - i / s.length);
      }
      const env = analyze(render(SR, s)).envelope;
      expect(env[0]?.db ?? 0).toBeGreaterThan((env[50]?.db ?? 0) + 3);
      expect(env[50]?.db ?? 0).toBeGreaterThan((env[95]?.db ?? 0) + 6);
    });
  });

  describe("duty cycle", () => {
    it.each([0.125, 0.25, 0.5, 0.75])(
      "measures a square at duty %f",
      (duty) => {
        const a = analyze(render(SR, pulse(SR, 0.5, 220, 0.4, duty)));
        expect(a.dutyCycle).not.toBeNull();
        expect(Math.abs((a.dutyCycle ?? 0) - duty)).toBeLessThan(0.01);
      }
    );

    it("ignores a DC offset and a decaying level", () => {
      const s = pulse(SR, 0.5, 330, 0.4, 0.25);
      for (let i = 0; i < s.length; i += 1) {
        s[i] = ((s[i] ?? 0) + 0.2) * (1 - (i / s.length) * 0.5);
      }
      expect(
        Math.abs((analyze(render(SR, s)).dutyCycle ?? 0) - 0.25)
      ).toBeLessThan(0.01);
    });

    it("measures after leading silence", () => {
      const body = pulse(SR, 0.3, 440, 0.4, 0.5);
      const s = new Float32Array(SR);
      s.set(body, 20_000);
      expect(
        Math.abs((analyze(render(SR, s)).dutyCycle ?? 0) - 0.5)
      ).toBeLessThan(0.02);
    });

    it("is null when the source is known not to be a square, and measured when it is", () => {
      const s = pulse(SR, 0.5, 220, 0.4, 0.25);
      expect(
        analyze(render(SR, s), { wave: "square" }).dutyCycle
      ).not.toBeNull();
      expect(analyze(render(SR, s), { wave: "saw" }).dutyCycle).toBeNull();
      expect(analyze(render(SR, s), { wave: null }).dutyCycle).toBeNull();
    });

    it("is null for a sine, for noise and for silence", () => {
      expect(analyze(render(SR, sine(SR, 0.5, 220, 0.4))).dutyCycle).toBeNull();
      expect(analyze(render(SR, noise(SR, 0.5, 0.4))).dutyCycle).toBeNull();
      expect(
        analyze(render(SR, new Float32Array(SR / 2))).dutyCycle
      ).toBeNull();
    });
  });

  it("produces JSON safe numbers only", () => {
    const a = analyze(render(SR, new Float32Array(SR / 4)));
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  it("is deterministic", () => {
    const r = render(SR, noise(SR, 1, 0.4, 7), noise(SR, 1, 0.4, 8));
    expect(analyze(r)).toEqual(analyze(r));
  });
});
