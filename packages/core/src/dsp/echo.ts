/* Master echo (section 3.6): a stereo delay line up to one second at the host rate, feedback through a one-pole
   lowpass, and a wet level. Fed by the per-voice sends. */

export class Echo {
  enabled = false;
  private readonly bufL: Float32Array;
  private readonly bufR: Float32Array;
  private readonly size: number;
  private pos = 0;
  private delay = 1;
  private feedback = 0;
  private level = 0;
  private lpA = 1;
  private lpL = 0;
  private lpR = 0;
  private readonly sr: number;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.size = Math.ceil(sampleRate) + 4;
    this.bufL = new Float32Array(this.size);
    this.bufR = new Float32Array(this.size);
  }

  configure(
    delaySeconds: number,
    feedback: number,
    level: number,
    lowpassHz: number
  ): void {
    this.delay = Math.min(
      this.size - 2,
      Math.max(1, Math.round(delaySeconds * this.sr))
    );
    this.feedback = Math.min(0.95, Math.max(0, feedback));
    this.level = level;
    const hz = Math.min(Math.max(lowpassHz, 100), this.sr * 0.45);
    this.lpA = 1 - Math.exp((-2 * Math.PI * hz) / this.sr);
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  reset(): void {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.pos = 0;
    this.lpL = 0;
    this.lpR = 0;
  }

  /** Adds the wet signal for n frames of send input into outL and outR. */
  process(
    inL: Float32Array,
    inR: Float32Array,
    outL: Float32Array,
    outR: Float32Array,
    n: number
  ): void {
    const size = this.size;
    const bl = this.bufL;
    const br = this.bufR;
    const a = this.lpA;
    const fb = this.feedback;
    const level = this.level;
    let pos = this.pos;
    let lpL = this.lpL;
    let lpR = this.lpR;
    let rd = pos - this.delay;
    if (rd < 0) {
      rd += size;
    }
    for (let i = 0; i < n; i += 1) {
      const dl = bl[rd] ?? 0;
      const dr = br[rd] ?? 0;
      lpL += a * (dl - lpL);
      lpR += a * (dr - lpR);
      bl[pos] = (inL[i] ?? 0) + lpL * fb;
      br[pos] = (inR[i] ?? 0) + lpR * fb;
      outL[i] = (outL[i] ?? 0) + lpL * level;
      outR[i] = (outR[i] ?? 0) + lpR * level;
      pos += 1;
      if (pos >= size) {
        pos = 0;
      }
      rd += 1;
      if (rd >= size) {
        rd = 0;
      }
    }
    this.pos = pos;
    this.lpL = lpL;
    this.lpR = lpR;
  }
}
