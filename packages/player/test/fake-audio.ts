// fallow-ignore-file unused-class-member
/* A recording stand-in for the parts of Web Audio the player touches. Time is whatever the test sets. */

import { BleepkitEngine, type EngineOptions } from "../src/worklet/engine.ts";
import {
  type FakeSynth,
  type FakeSynthOptions,
  fakeSynthFactory,
} from "./fake-synth.ts";

interface Automation {
  kind: "set" | "ramp";
  time: number;
  value: number;
}

/** An AudioParam with its automation timeline, so a test can ask what level it has at a given time (valueAt) instead
    of inspecting which calls were made. `value` reads the level now, like a browser, so a ramp that starts from
    `param.value` continues from where an interrupted ramp had got to. */
class FakeParam {
  readonly log: [method: string, ...args: number[]][] = [];
  private readonly initial: number;
  private readonly clock: () => number;
  private events: Automation[] = [];
  private held: number | null = null;
  constructor(initial = 1, clock: () => number = () => 0) {
    this.initial = initial;
    this.clock = clock;
  }
  private schedule(kind: Automation["kind"], value: number, time: number) {
    this.held = null;
    let at = this.events.length;
    while (at > 0 && (this.events[at - 1]?.time ?? 0) > time) {
      at -= 1;
    }
    this.events.splice(at, 0, { kind, time, value });
  }
  /** The level now; assigning it sets the level from now on (no entry in `log`, like a plain property write). */
  get value(): number {
    return this.held ?? this.valueAt(this.clock());
  }
  set value(v: number) {
    this.schedule("set", v, this.clock());
  }
  /** The level at context time `t`, from the scheduled steps and linear ramps. */
  valueAt(t: number): number {
    let prevTime = 0;
    let prevValue = this.initial;
    for (const e of this.events) {
      if (e.kind === "set") {
        if (e.time > t) {
          return prevValue;
        }
      } else if (t < e.time) {
        if (t <= prevTime) {
          return prevValue;
        }
        const along = (t - prevTime) / (e.time - prevTime);
        return prevValue + (e.value - prevValue) * along;
      }
      prevTime = e.time;
      prevValue = e.value;
    }
    return prevValue;
  }
  setValueAtTime(v: number, t: number) {
    this.log.push(["set", v, t]);
    this.schedule("set", v, t);
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.log.push(["ramp", v, t]);
    this.schedule("ramp", v, t);
    return this;
  }
  cancelScheduledValues(t: number) {
    this.log.push(["cancel", t]);
    // a browser keeps answering with the level it had reached until something new is scheduled
    this.held = this.valueAt(this.clock());
    this.events = this.events.filter((e) => e.time < t);
    return this;
  }
  /** The last scheduled ramp target, or the value when none. */
  get target(): number {
    const ramps = this.log.filter((l) => l[0] === "ramp");
    const last = ramps.at(-1);
    return last ? (last[1] as number) : this.value;
  }
}

class FakeNode {
  readonly outputs: FakeNode[] = [];
  disconnected = false;
  connect<T extends FakeNode>(node: T): T {
    this.outputs.push(node);
    return node;
  }
  disconnect() {
    this.disconnected = true;
    this.outputs.length = 0;
  }
  /** Whether `target` can be reached by following connections from this node. */
  reaches(target: FakeNode, seen = new Set<FakeNode>()): boolean {
    if (this === target) {
      return true;
    }
    if (seen.has(this)) {
      return false;
    }
    seen.add(this);
    return this.outputs.some((out) => out.reaches(target, seen));
  }
}

class FakeGain extends FakeNode {
  readonly gain: FakeParam;
  constructor(clock?: () => number) {
    super();
    this.gain = new FakeParam(1, clock);
  }
}
class FakePanner extends FakeNode {
  readonly pan: FakeParam;
  constructor(clock?: () => number) {
    super();
    this.pan = new FakeParam(0, clock);
  }
}
class FakeBuffer {
  readonly duration: number;
  constructor(duration: number) {
    this.duration = duration;
  }
}

export class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate: FakeParam;
  onended: (() => void) | null = null;
  starts: { when: number | undefined; offset: number | undefined }[] = [];
  stops: (number | undefined)[] = [];
  private readonly clock: () => number;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  private offsetSeconds = 0;
  private ended = false;
  constructor(clock: () => number = () => 0) {
    super();
    this.clock = clock;
    this.playbackRate = new FakeParam(1, clock);
  }
  start(when?: number, offset?: number) {
    this.starts.push({ offset, when });
    this.startedAt ??= when ?? this.clock();
    this.offsetSeconds = offset ?? 0;
  }
  stop(when?: number) {
    this.stops.push(when);
    this.stoppedAt = when ?? this.clock();
  }
  /** The buffer ran out (or stop time was reached). */
  finish() {
    this.ended = true;
    this.onended?.();
  }
  /** Whether the source is producing samples at context time `t`: started, not stopped, not run out, not ended. */
  soundingAt(t: number): boolean {
    if (this.startedAt === null || t < this.startedAt || this.ended) {
      return false;
    }
    if (this.stoppedAt !== null && t >= this.stoppedAt) {
      return false;
    }
    if (!this.loop && this.buffer) {
      const rate = this.playbackRate.valueAt(t);
      const length = (this.buffer.duration - this.offsetSeconds) / rate;
      return t < this.startedAt + length;
    }
    return true;
  }
}

/** Audio "files" are ArrayBuffers whose first 8 bytes are the duration in seconds. */
export function audioBytes(duration: number): ArrayBuffer {
  const bytes = new ArrayBuffer(16);
  new DataView(bytes).setFloat64(0, duration);
  return bytes;
}

export class FakeContext {
  currentTime = 0;
  sampleRate = 48_000;
  state: "suspended" | "running" | "closed" = "suspended";
  outputLatency = 0.05;
  baseLatency = 0.01;
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly sources: FakeSource[] = [];
  readonly panners: FakePanner[] = [];
  readonly modules: string[] = [];
  resumes = 0;
  closed = false;
  decodeFails = false as boolean;
  readonly audioWorklet = {
    addModule: (url: string) => {
      if (this.moduleError) {
        return Promise.reject(new Error(this.moduleError));
      }
      this.modules.push(url);
      return Promise.resolve();
    },
  };
  moduleError: string | null = null;

  readonly options: unknown;
  constructor(options?: unknown) {
    this.options = options;
  }
  private readonly clock = () => this.currentTime;
  createGain() {
    const g = new FakeGain(this.clock);
    this.gains.push(g);
    return g;
  }
  createBufferSource() {
    const s = new FakeSource(this.clock);
    this.sources.push(s);
    return s;
  }
  createStereoPanner() {
    const p = new FakePanner(this.clock);
    this.panners.push(p);
    return p;
  }
  decodeAudioData(bytes: ArrayBuffer): Promise<FakeBuffer> {
    if (this.decodeFails) {
      return Promise.reject(new Error("EncodingError"));
    }
    return Promise.resolve(new FakeBuffer(new DataView(bytes).getFloat64(0)));
  }
  resume() {
    this.resumes += 1;
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    this.state = "closed";
    return Promise.resolve();
  }
  asContext(): AudioContext {
    return this as unknown as AudioContext;
  }
  /** How much of `node`'s output comes out of the speakers at context time `at`: the sum over every path from the
      node to the destination of the product of the gains along it. 0 when no path reaches the destination. */
  audibleGain(node: FakeNode, at = this.currentTime): number {
    const walk = (n: FakeNode, level: number, path: Set<FakeNode>): number => {
      if (n === this.destination) {
        return level;
      }
      if (path.has(n)) {
        return 0;
      }
      const through =
        n instanceof FakeGain ? level * n.gain.valueAt(at) : level;
      path.add(n);
      let sum = 0;
      for (const out of n.outputs) {
        sum += walk(out, through, path);
      }
      path.delete(n);
      return sum;
    };
    return walk(node, 1, new Set());
  }
  /** The audible gain of a buffer source while it is actually sounding, else 0. */
  heard(source: FakeSource, at = this.currentTime): number {
    return source.soundingAt(at) ? this.audibleGain(source, at) : 0;
  }
  /** How many of the buffer sources made so far are audible at `at`. */
  soundingCount(at = this.currentTime): number {
    return this.sources.filter((s) => this.heard(s, at) > 0).length;
  }
}

class FakeMessagePort {
  readonly sent: unknown[] = [];
  private handler: ((e: { data: unknown }) => void) | null = null;
  private readonly queue: unknown[] = [];
  closed = false;
  /** Receives what the main thread posts (the worklet side). */
  toWorklet: ((data: unknown) => void) | null = null;
  get onmessage() {
    return this.handler;
  }
  set onmessage(fn: ((e: { data: unknown }) => void) | null) {
    this.handler = fn;
    if (fn) {
      for (const data of this.queue.splice(0)) {
        fn({ data });
      }
    }
  }
  postMessage(data: unknown) {
    this.sent.push(data);
    this.toWorklet?.(data);
  }
  /** The worklet posts to the main thread; queued until a handler is set, like a real port. */
  emit(data: unknown) {
    if (this.handler) {
      this.handler({ data });
    } else {
      this.queue.push(data);
    }
  }
  close() {
    this.closed = true;
  }
}

export interface Linked {
  engine: BleepkitEngine;
  node: FakeWorkletNode;
  /** Largest sample the engine rendered during the latest `runBlocks`. */
  peak: number;
  synth: () => FakeSynth;
}

export class FakeWorkletNode extends FakeNode {
  static instances: FakeWorkletNode[] = [];
  /** Called for every node made; the default announces `ready` like a healthy processor. */
  static hook: ((node: FakeWorkletNode) => void) | null = null;
  readonly port = new FakeMessagePort();
  onprocessorerror: (() => void) | null = null;
  linked: Linked | null = null;
  readonly ctx: FakeContext;
  readonly name: string;
  readonly options: { processorOptions?: Record<string, unknown> };
  constructor(
    ctx: FakeContext,
    name: string,
    options: { processorOptions?: Record<string, unknown> }
  ) {
    super();
    this.ctx = ctx;
    this.name = name;
    this.options = options;
    FakeWorkletNode.instances.push(this);
    (FakeWorkletNode.hook ?? FakeWorkletNode.announce)(this);
  }
  static announce(node: FakeWorkletNode) {
    node.port.emit({ sampleRate: node.ctx.sampleRate, type: "ready" });
  }
}

/** Wire each worklet node to a real BleepkitEngine running a FakeSynth, driven by `runBlocks`. */
export function linkWorklets(synthOpts: FakeSynthOptions = {}) {
  const linked: Linked[] = [];
  FakeWorkletNode.hook = (node) => {
    const factory = fakeSynthFactory(synthOpts);
    const engine = new BleepkitEngine(
      { postMessage: (m) => node.port.emit(m) },
      {
        createSynth: factory.create,
        currentTime: () => node.ctx.currentTime,
        sampleRate: node.ctx.sampleRate,
      },
      (node.options.processorOptions ?? {}) as EngineOptions
    );
    node.port.toWorklet = (data) => engine.handleMessage(data);
    const entry: Linked = {
      engine,
      node,
      peak: 0,
      synth: () => {
        const [s] = factory.made;
        if (!s) {
          throw new Error("no synth");
        }
        return s;
      },
    };
    node.linked = entry;
    linked.push(entry);
  };
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  return {
    linked,
    /** Render n blocks on every linked engine, advancing the context's clock like the audio thread does. */
    runBlocks(ctx: FakeContext, n: number) {
      for (const l of linked) {
        l.peak = 0;
      }
      for (let i = 0; i < n; i += 1) {
        for (const l of linked) {
          l.engine.process([[left, right]]);
          for (let k = 0; k < left.length; k += 1) {
            l.peak = Math.max(
              l.peak,
              Math.abs(left[k] ?? 0),
              Math.abs(right[k] ?? 0)
            );
          }
        }
        ctx.currentTime += 128 / ctx.sampleRate;
      }
    },
  };
}

/** How loud an engine node is at the speakers right now: what it rendered in the latest `runBlocks`, scaled by every
    gain between it and the destination. 0 when it renders silence or is not connected through to the destination. */
export function heardLevel(ctx: FakeContext, linked: Linked): number {
  return linked.peak * ctx.audibleGain(linked.node);
}

export function installWebAudioGlobals() {
  FakeWorkletNode.instances = [];
  FakeWorkletNode.hook = null;
  return FakeWorkletNode;
}

/** A fetch stub over a url -> body map: ArrayBuffer bodies are audio, anything else is JSON. */
export function fakeFetch(files: Record<string, ArrayBuffer | unknown>) {
  const requested: string[] = [];
  const fn = (url: string | URL | Request) => {
    const key = String(url);
    requested.push(key);
    if (!(key in files)) {
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: "Not Found",
      } as Response);
    }
    const body = files[key];
    return Promise.resolve({
      arrayBuffer: () => Promise.resolve(body as ArrayBuffer),
      json: () => Promise.resolve(body),
      ok: true,
      status: 200,
      statusText: "OK",
    } as unknown as Response);
  };
  return { fn, requested };
}
