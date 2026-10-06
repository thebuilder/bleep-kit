import { describe, expect, it } from "vitest";
import { analyze } from "../../src/tools/analysis.ts";
import { integratedLufs } from "../../src/tools/loudness.ts";
import { dbToAmp, noise, pulse, render, sine } from "./helpers.ts";

const SR = 48_000;

/** A copy of a mono buffer with these frames added to. */
function bump(plane: Float32Array, at: number, by: number): Float32Array {
  const copy = plane.slice();
  copy[at] = (copy[at] ?? 0) + by;
  return copy;
}

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

  it("reports K-weighted integrated loudness in LUFS, rounded to two decimals", () => {
    const a = analyze(render(SR, sine(SR, 3, 1000, dbToAmp(-20))));
    expect(a.lufs).toBeCloseTo(-20, 1);
    expect(a.lufs).toBe(Math.round(a.lufs * 100) / 100);
  });

  describe("clipping", () => {
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

    it("sees a clip in either channel and counts a frame once when both clip", () => {
      const quiet = () => new Float32Array(1000);
      const left = quiet();
      const right = quiet();
      right[300] = -1; // only the right channel
      left[700] = 1;
      right[700] = 1; // both channels, one frame
      const a = analyze(render(SR, left, right));
      expect(a.clipped.frames).toBe(2);
      expect(a.clipped.first).toBe(300);
    });

    it("clips from 0.999 up and not below", () => {
      const s = new Float32Array(100);
      s[10] = 0.998;
      s[20] = -0.9985;
      expect(analyze(render(SR, s)).clipped).toEqual({
        first: null,
        frames: 0,
      });
      s[30] = -0.9991;
      expect(analyze(render(SR, s)).clipped).toEqual({ first: 30, frames: 1 });
    });
  });

  it("reads a DC offset", () => {
    const s = sine(SR, 1, 440, 0.2);
    for (let i = 0; i < s.length; i += 1) {
      s[i] = (s[i] ?? 0) + 0.1;
    }
    expect(analyze(render(SR, s)).dcOffset).toBeCloseTo(0.1, 4);
  });

  describe("silence", () => {
    it("finds leading and trailing silence and a silent quietest window", () => {
      const body = sine(SR, 0.5, 440, 0.5);
      const s = new Float32Array(SR * 1);
      s.set(body, Math.round(SR * 0.25));
      const a = analyze(render(SR, s));
      expect(a.leadingSilence).toBeCloseTo(0.25, 2);
      expect(a.trailingSilence).toBeCloseTo(0.25, 2);
      expect(a.silenceDb).toBe(-120);
    });

    it("reports the level of the quietest 50 ms window", () => {
      // half a second at 0.5 then half a second at 0.005; 2400 frames hold 22 whole periods of 440 Hz
      const s = new Float32Array(SR);
      s.set(sine(SR, 0.5, 440, 0.5), 0);
      s.set(sine(SR, 0.5, 440, 0.005), SR / 2);
      expect(analyze(render(SR, s)).silenceDb).toBeCloseTo(
        20 * Math.log10(0.005 / Math.SQRT2),
        1
      );
    });

    it("treats everything under -60 dBFS (0.001) at the ends as silence", () => {
      const lead = (amp: number) => {
        const s = new Float32Array(SR / 2);
        s.set(sine(SR, 0.1, 440, amp), 0);
        s.set(sine(SR, 0.4, 440, 0.5), SR / 10);
        return analyze(render(SR, s)).leadingSilence;
      };
      // -66 dBFS lead-in: silence, so the sound starts after 100 ms
      expect(lead(0.0005)).toBeCloseTo(0.1, 3);
      // -54 dBFS lead-in is already sound
      expect(lead(0.002)).toBeLessThan(0.002);
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
    it("reads no difference for a seamless periodic loop", () => {
      // a 100 Hz sine has a 480 frame period, so loops cut on whole periods repeat exactly
      const s = sine(SR, 0.5, 100, 0.5);
      const a = analyze(
        render(SR, s, s, { loopEnd: 480 * 40, loopStart: 480 * 10 })
      );
      expect(a.loop?.start).toBeCloseTo((480 * 10) / SR, 4);
      expect(a.loop?.end).toBeCloseTo((480 * 40) / SR, 4);
      expect(a.loop?.seamDiffDb ?? 0).toBeLessThan(-60);
    });

    it("measures a quarter period mismatch as the amplitude of the sine", () => {
      // the 5 ms compared is half a period of 100 Hz. Shifting a sine of amplitude A by a quarter period gives a
      // difference of amplitude A * sqrt(2), whose RMS is A: 0.5 is -6.02 dB.
      const s = sine(SR, 0.5, 100, 0.5);
      const a = analyze(
        render(SR, s, s, { loopEnd: 480 * 40 + 120, loopStart: 480 * 10 })
      );
      expect(a.loop?.seamDiffDb).toBeCloseTo(-6.02, 1);
    });

    describe("compares the 5 ms before the loop end with the 5 ms before the loop start", () => {
      const start = 6000;
      const end = 18_000;
      const window = 240; // 5 ms
      /** Noise in which the 5 ms before `end` is a copy of the 5 ms before `start`, and everything else differs. */
      function seamless(seed: number): Float32Array {
        const plane = noise(SR, 0.5, 0.5, seed);
        plane.set(plane.subarray(start - window, start), end - window);
        return plane;
      }
      const seam = (left: Float32Array, right = seamless(2)) =>
        analyze(render(SR, left, right, { loopEnd: end, loopStart: start }))
          .loop?.seamDiffDb;

      it("is silent when the two stretches are identical, whatever the audio around them", () => {
        expect(seam(seamless(1))).toBe(-120);
      });

      it("does not look at the audio at or after the loop start, or at or after the loop end", () => {
        // the noise right after `start` and right after `end` differs, which would show if either were compared
        expect(seam(bump(seamless(1), start, 0.5))).toBe(-120);
        expect(seam(bump(seamless(1), end, 0.5))).toBe(-120);
      });

      it("covers exactly 5 ms: the frame just before the window is ignored, the first frame inside it counts", () => {
        expect(seam(bump(seamless(1), end - window - 1, 0.5))).toBe(-120);
        // one frame off by 0.5 in one of two channels: mean square 0.25 / (240 * 2) = -32.83 dB
        expect(seam(bump(seamless(1), end - window, 0.5))).toBeCloseTo(
          -32.83,
          1
        );
      });

      it("reads the RMS of the difference over both channels", () => {
        // 0.1 added all over the window of the left channel only: mean square 0.01 / 2 = -23.01 dB
        const left = seamless(1);
        for (let i = end - window; i < end; i += 1) {
          left[i] = (left[i] ?? 0) + 0.1;
        }
        expect(seam(left)).toBeCloseTo(-23.01, 1);
      });
    });

    it("has no seam reading when the loop starts too early to look back from, or ends past the file", () => {
      const s = sine(SR, 0.5, 100, 0.5);
      const early = analyze(
        render(SR, s, s, { loopEnd: 480 * 40, loopStart: 0 })
      );
      expect(early.loop?.seamDiffDb).toBeNull();
      expect(early.loop?.start).toBe(0);
      const short = analyze(
        render(SR, s, s, { loopEnd: 480 * 40, loopStart: 239 })
      );
      expect(short.loop?.seamDiffDb).toBeNull();
      const past = analyze(
        render(SR, s, s, { loopEnd: SR, loopStart: 480 * 10 })
      );
      expect(past.loop?.seamDiffDb).toBeNull();
    });

    it("has a reading when the loop starts exactly 5 ms in and when it ends exactly at the end of the file", () => {
      const s = sine(SR, 0.5, 100, 0.5);
      // 240 frames in: the compared stretches are half a period apart, so the difference is 2 * 0.5 / sqrt(2) RMS
      const edge = analyze(
        render(SR, s, s, { loopEnd: 480 * 40, loopStart: 240 })
      );
      expect(edge.loop?.seamDiffDb).toBeCloseTo(-3.01, 1);
      const atEnd = analyze(
        render(SR, s, s, { loopEnd: s.length, loopStart: 480 * 10 })
      );
      expect(atEnd.loop?.seamDiffDb).not.toBeNull();
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

    it("widens the envelope step to keep at most 1000 points, still covering the whole file", () => {
      // not about the rate: 10.5 s of noise at a low one
      const rate = 8000;
      const noiseRun = noise(rate, 10.5, 0.3);
      const a = analyze({
        channels: [noiseRun],
        events: [],
        frames: noiseRun.length,
        sampleRate: rate,
      });
      expect(a.envelope.length).toBeLessThanOrEqual(1000);
      expect(a.envelope.length).toBeGreaterThan(900);
      expect(a.envelope.at(-1)?.time ?? 0).toBeGreaterThan(10.4);
    });

    it("follows a linear decay at the level the sine has at that moment", () => {
      const s = sine(SR, 1, 440, 0.8);
      for (let i = 0; i < s.length; i += 1) {
        s[i] = (s[i] ?? 0) * (1 - i / s.length);
      }
      const env = analyze(render(SR, s)).envelope;
      // a sine of amplitude 0.8 * (1 - t), measured over the 10 ms step that starts at t
      for (const [index, t] of [
        [0, 0.005],
        [50, 0.505],
        [95, 0.955],
      ] as const) {
        const expected = 20 * Math.log10((0.8 * (1 - t)) / Math.SQRT2);
        expect(Math.abs((env[index]?.db ?? 0) - expected)).toBeLessThan(0.2);
      }
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

    it("is only measured when the source is a square, or not known", () => {
      const s = pulse(SR, 0.5, 220, 0.4, 0.25);
      expect(analyze(render(SR, s), { wave: "square" }).dutyCycle).toBeCloseTo(
        0.25,
        2
      );
      expect(analyze(render(SR, s), { wave: "saw" }).dutyCycle).toBeNull();
      expect(analyze(render(SR, s), { wave: null }).dutyCycle).toBeNull();
    });

    it("is null for a sine, a sawtooth, noise and silence", () => {
      const saw = new Float32Array(SR / 2);
      for (let i = 0; i < saw.length; i += 1) {
        saw[i] = 0.8 * (2 * (((i * 220) / SR) % 1) - 1);
      }
      expect(analyze(render(SR, sine(SR, 0.5, 220, 0.4))).dutyCycle).toBeNull();
      expect(analyze(render(SR, saw)).dutyCycle).toBeNull();
      expect(analyze(render(SR, noise(SR, 0.5, 0.4))).dutyCycle).toBeNull();
      expect(
        analyze(render(SR, new Float32Array(SR / 2))).dutyCycle
      ).toBeNull();
    });
  });

  it("produces JSON safe numbers only, for silence, an empty file and a single frame", () => {
    for (const plane of [
      new Float32Array(SR / 4),
      new Float32Array(0),
      Float32Array.from([0.5]),
    ]) {
      const a = analyze(render(SR, plane));
      expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    }
  });

  it("gives the same result for the same input however many other analyses ran in between", () => {
    const r = render(SR, noise(SR, 1, 0.4, 7), noise(SR, 1, 0.4, 8));
    const first = analyze(r);
    analyze(
      render(SR, sine(SR, 0.7, 523, 0.9), undefined, {
        loopEnd: 20_000,
        loopStart: 5000,
      })
    );
    analyze(render(44_100, pulse(44_100, 0.3, 300, 0.5, 0.25)));
    expect(analyze(r)).toEqual(first);
  });
});

describe("integratedLufs (ITU-R BS.1770)", () => {
  const lufs = (rate: number, seconds: number, hz: number, amp: number) => {
    const tone = sine(rate, seconds, hz, amp);
    return integratedLufs([tone, tone], tone.length, rate);
  };

  // A stereo 1 kHz sine at -20 dBFS peak reads -20.0 LUFS (the EBU Tech 3341 test signal, one level lower).
  it.each([32_000, 44_100, 48_000, 96_000])(
    "reads stereo 1 kHz at -20 dBFS as -20 LUFS at %i Hz",
    (rate) => {
      expect(lufs(rate, 3, 1000, dbToAmp(-20))).toBeCloseTo(-20, 1);
    }
  );

  it("counts a mono file once: the same tone reads 3 LU lower than in both channels", () => {
    const tone = sine(SR, 3, 1000, dbToAmp(-20));
    const single = integratedLufs([tone], tone.length, SR);
    expect(single).toBeCloseTo(-23.01, 1);
  });

  // K-weighting magnitude relative to 1 kHz, from the ITU-R BS.1770 coefficients for 48 kHz (shelf b = 1.53512485958697,
  // -2.69169618940638, 1.19839281085285, a = 1, -1.69065929318241, 0.73248077421585; high pass b = 1, -2, 1,
  // a = 1, -1.99004745483398, 0.99007225036621) evaluated with scipy.signal.freqz.
  it.each([
    [48_000, 40, -6.265],
    [48_000, 100, -1.831],
    [48_000, 3000, 3.11],
    [48_000, 10_000, 3.344],
    [44_100, 40, -6.265],
    [44_100, 10_000, 3.344],
  ])(
    "at %i Hz weights a %i Hz tone %f dB relative to 1 kHz",
    (rate, hz, expected) => {
      const reference = lufs(rate, 3, 1000, 0.3);
      expect(
        Math.abs(lufs(rate, 3, hz, 0.3) - reference - expected)
      ).toBeLessThan(0.1);
    }
  );

  it("gates digital silence out", () => {
    const loud = sine(SR, 2, 1000, 0.25);
    const padded = new Float32Array(SR * 6);
    padded.set(loud, 0);
    const whole = integratedLufs([loud], loud.length, SR);
    expect(integratedLufs([padded], padded.length, SR)).toBeCloseTo(whole, 0);
  });

  it("gates out passages more than 10 LU below the rest, even when they are above -70 LUFS", () => {
    // 2 s at -20 dBFS then 4 s at -40 dBFS: averaging both would read -24.7 LUFS, the relative gate keeps the loud part
    const loud = sine(SR, 2, 1000, dbToAmp(-20));
    const both = new Float32Array(SR * 6);
    both.set(loud, 0);
    both.set(sine(SR, 4, 1000, dbToAmp(-40)), SR * 2);
    const loudOnly = integratedLufs([loud], loud.length, SR);
    const gated = integratedLufs([both], both.length, SR);
    expect(Math.abs(gated - loudOnly)).toBeLessThan(0.5);
  });

  it("measures material shorter than one 400 ms block as a whole", () => {
    // a stereo 1 kHz sine of amplitude 0.5 is -6.0 LUFS
    expect(lufs(SR, 0.1, 1000, 0.5)).toBeCloseTo(-6, 0);
  });

  it("reads silence and nothing as -Infinity", () => {
    expect(integratedLufs([new Float32Array(SR)], SR, SR)).toBe(
      Number.NEGATIVE_INFINITY
    );
    expect(integratedLufs([], 0, SR)).toBe(Number.NEGATIVE_INFINITY);
  });
});
