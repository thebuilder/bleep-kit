// fallow-ignore-file unused-class-member
/* A recording stand-in for the parts of Web Audio the player touches. Time is whatever the test sets. */

import { BleepkitEngine, type EngineOptions } from "../src/worklet/engine.ts";
import {
  type FakeSynth,
  type FakeSynthOptions,
  fakeSynthFactory,
} from "./fake-synth.ts";

class FakeParam {
  value: number;
  readonly log: [method: string, ...args: number[]][] = [];
  constructor(initial = 1) {
    this.value = initial;
  }
  setValueAtTime(v: number, t: number) {
    this.log.push(["set", v, t]);
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.log.push(["ramp", v, t]);
    return this;
  }
  cancelScheduledValues(t: number) {
    this.log.push(["cancel", t]);
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
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);
}
class FakePanner extends FakeNode {
  readonly pan = new FakeParam(0);
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
  readonly playbackRate = new FakeParam(1);
  onended: (() => void) | null = null;
  starts: { when: number | undefined; offset: number | undefined }[] = [];
  stops: (number | undefined)[] = [];
  start(when?: number, offset?: number) {
    this.starts.push({ offset, when });
  }
  stop(when?: number) {
    this.stops.push(when);
  }
  /** The buffer ran out (or stop time was reached). */
  finish() {
    this.onended?.();
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
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createStereoPanner() {
    const p = new FakePanner();
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
      for (let i = 0; i < n; i += 1) {
        for (const l of linked) {
          l.engine.process([[left, right]]);
        }
        ctx.currentTime += 128 / ctx.sampleRate;
      }
    },
  };
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
