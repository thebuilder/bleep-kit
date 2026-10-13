/* Recorded shapes of Freesound's answers, for tests and for `FREESOUND_FIXTURES=1 pnpm dev` (the dev server then answers
   from here instead of freesound.org, so the panel can be built and checked with no key and no network).

   The JSON follows the API docs (https://freesound.org/docs/api/resources_apiv2.html): the search resource's
   `count`, `next`, `previous`, `results`, the sound instance fields (license strings "Creative Commons 0",
   "Attribution", "Attribution NonCommercial"; `previews` and `images` dictionaries; the `note_name`, `single_event`
   and `loopable` descriptors, which come back only when asked for in `fields`). The sounds are made up and their audio
   is synthesised here. The fake search is deliberately sloppy in one way a real phrase search might be: a filter for
   "Attribution" also matches "Attribution NonCommercial", so the handler's own license check is exercised. */
import { encodePng } from "@bleepkit/core/tools";

export const FIXTURE_KEY = "fixture-api-key";

const RATE = 22_050;

type Recipe =
  | "kick"
  | "snare"
  | "hat"
  | "clap"
  | "tom"
  | "cymbal"
  | "pluck"
  | "bass"
  | "pad"
  | "stab"
  | "lead"
  | "choir"
  | "hit"
  | "keys"
  | "wind";

type LicenseName =
  | "Creative Commons 0"
  | "Attribution"
  | "Attribution NonCommercial"
  | "Sampling+";

interface Spec {
  category?: string;
  dl: number;
  dur: number;
  id: number;
  license: LicenseName;
  loop?: boolean;
  name: string;
  note?: string;
  rating: number;
  ratings: number;
  recipe: Recipe;
  single: boolean;
  sub: string;
  tags: string[];
  user: string;
}

const IS = "Instrument samples";

/** [recipe, name, tags, duration, license, note, single] per sound; ids and the rest are filled in below. */
type Row = [
  Recipe,
  string,
  string,
  number,
  LicenseName,
  string | null,
  boolean,
];

const PERC: Row[] = [
  [
    "kick",
    "808 kick deep",
    "kick 808 drum",
    0.6,
    "Creative Commons 0",
    "F1",
    true,
  ],
  [
    "kick",
    "Punchy kick",
    "kick drum chiptune",
    0.3,
    "Creative Commons 0",
    null,
    true,
  ],
  ["kick", "909 kick long", "kick 909 drum", 0.8, "Attribution", "G1", true],
  [
    "snare",
    "Snare tight",
    "snare drum 909",
    0.25,
    "Creative Commons 0",
    null,
    true,
  ],
  [
    "snare",
    "8-bit snare",
    "snare 8-bit chiptune",
    0.2,
    "Creative Commons 0",
    null,
    true,
  ],
  ["snare", "Snare room", "snare drum", 0.5, "Attribution", null, true],
  [
    "hat",
    "Closed hihat",
    "hihat closed drum",
    0.08,
    "Creative Commons 0",
    null,
    true,
  ],
  [
    "hat",
    "Open hihat",
    "hihat open drum",
    0.35,
    "Creative Commons 0",
    null,
    true,
  ],
  ["clap", "Clap dry", "clap drum 808", 0.22, "Creative Commons 0", null, true],
  ["clap", "Clap stack", "clap drum", 0.4, "Attribution", null, true],
  ["tom", "Tom low", "tom drum", 0.5, "Creative Commons 0", "D2", true],
  ["tom", "Tom high", "tom drum", 0.35, "Creative Commons 0", "A2", true],
  [
    "cymbal",
    "Crash cymbal",
    "cymbal crash",
    1.8,
    "Creative Commons 0",
    null,
    true,
  ],
  ["cymbal", "Ride bell", "cymbal ride", 1.2, "Attribution", null, true],
  [
    "kick",
    "Kick (non commercial)",
    "kick drum",
    0.4,
    "Attribution NonCommercial",
    null,
    true,
  ],
  [
    "snare",
    "Snare (sampling plus)",
    "snare drum",
    0.3,
    "Sampling+",
    null,
    true,
  ],
];

const STRING: Row[] = [
  [
    "pluck",
    "Pluck A3",
    "pluck string guitar",
    0.9,
    "Creative Commons 0",
    "A3",
    true,
  ],
  ["pluck", "Harp pluck", "pluck harp", 1.4, "Creative Commons 0", "C4", true],
  ["pluck", "Bass pluck E1", "pluck bass string", 1, "Attribution", "E1", true],
  [
    "stab",
    "String stab",
    "stab orchestra string",
    0.7,
    "Creative Commons 0",
    "D3",
    true,
  ],
  [
    "pluck",
    "Banjo twang",
    "pluck banjo",
    1.1,
    "Creative Commons 0",
    "G3",
    true,
  ],
];

const WIND: Row[] = [
  ["wind", "Flute note", "flute wind", 1.6, "Creative Commons 0", "C5", false],
  [
    "wind",
    "Breathy pad",
    "wind breath",
    3.2,
    "Creative Commons 0",
    null,
    false,
  ],
  ["wind", "Whistle", "whistle wind", 0.9, "Attribution", "E5", true],
];

const KEYS: Row[] = [
  ["keys", "Piano C4", "piano keys", 2.4, "Creative Commons 0", "C4", true],
  [
    "keys",
    "Electric piano",
    "piano keys electric",
    1.8,
    "Creative Commons 0",
    "F3",
    true,
  ],
  ["keys", "Organ chord", "chord organ keys", 2.2, "Attribution", "C3", false],
  [
    "stab",
    "Piano chord stab",
    "chord stab piano",
    0.8,
    "Creative Commons 0",
    "G3",
    true,
  ],
];

const SYNTH: Row[] = [
  [
    "bass",
    "Sub bass 808",
    "bass 808 synth",
    1.2,
    "Creative Commons 0",
    "F1",
    true,
  ],
  ["bass", "Saw bass", "bass synth saw", 0.9, "Creative Commons 0", "E2", true],
  [
    "lead",
    "Chiptune lead",
    "lead chiptune 8-bit synth",
    1.3,
    "Creative Commons 0",
    "A4",
    true,
  ],
  [
    "lead",
    "Square lead",
    "lead synth 8-bit",
    0.8,
    "Creative Commons 0",
    "C5",
    true,
  ],
  ["pad", "Warm pad", "pad synth", 4.5, "Creative Commons 0", "C3", false],
  [
    "stab",
    "Synth stab",
    "stab chord synth",
    0.5,
    "Creative Commons 0",
    "D3",
    true,
  ],
  [
    "hit",
    "Orchestra hit",
    "orchestra-hit stab synth",
    0.9,
    "Creative Commons 0",
    "C3",
    true,
  ],
  [
    "choir",
    "Choir ah",
    "choir vocal pad",
    3.4,
    "Creative Commons 0",
    "A3",
    false,
  ],
  [
    "pluck",
    "Amiga pluck",
    "pluck amiga chiptune",
    0.7,
    "Attribution",
    "G3",
    true,
  ],
  [
    "lead",
    "Lead (non commercial)",
    "lead synth",
    1,
    "Attribution NonCommercial",
    "A4",
    true,
  ],
];

function specs(): Spec[] {
  const out: Spec[] = [];
  let id = 480_100;
  const add = (sub: string, rows: Row[]): void => {
    for (const [recipe, name, tags, dur, license, note, single] of rows) {
      id += 37;
      out.push({
        dl: (id % 997) * 3 + 40,
        dur,
        id,
        license,
        loop: !single && dur > 2,
        name,
        ...(note ? { note } : {}),
        rating: 3 + (id % 20) / 10,
        ratings: 2 + (id % 9),
        recipe,
        single,
        sub,
        tags: tags.split(" "),
        user:
          ["kickmaker", "wavesmith", "noisebox", "tapehead", "pixelfoley"][
            id % 5
          ] ?? "anon",
      });
    }
  };
  add("Percussion", PERC);
  add("String", STRING);
  add("Wind", WIND);
  add("Piano / Keyboard instruments", KEYS);
  add("Synths / Electronic", SYNTH);
  // not in "Instrument samples": the category filter must keep it out
  out.push({
    category: "Sound effects",
    dl: 12,
    dur: 0.6,
    id: 480_099,
    license: "Creative Commons 0",
    name: "Door slam",
    rating: 4,
    ratings: 5,
    recipe: "hit",
    single: true,
    sub: "Objects / House appliances",
    tags: ["door", "slam"],
    user: "foleyfan",
  });
  return out;
}

export const FIXTURE_SPECS: readonly Spec[] = specs();

/* ---------- audio ---------- */

function noise(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s / 0xff_ff_ff_ff) * 2 - 1;
  };
}

const NOTE_NAME = /^([A-G])([#b]?)(-?\d)$/;
const CDN_ID = /\/(\d+)_\d+[-_]/;
const API_SOUND_PATH = /^\/apiv2\/sounds\/(\d+)\/$/;
const DURATION_MAX = /TO ([\d.]+)/;

const hzOf = (note: string | undefined, fallback: number): number => {
  const m = NOTE_NAME.exec(note ?? "");
  if (!m) {
    return fallback;
  }
  const semis: Record<string, number> = {
    A: 9,
    B: 11,
    C: 0,
    D: 2,
    E: 4,
    F: 5,
    G: 7,
  };
  const accidental = { "#": 1, b: -1 }[m[2] ?? ""] ?? 0;
  const midi = (Number(m[3]) + 1) * 12 + (semis[m[1] ?? "C"] ?? 0) + accidental;
  return 440 * 2 ** ((midi - 69) / 12);
};

/** One voice sample at time t (seconds), for a recipe; the envelope is applied by the caller. */
function voice(r: Recipe, t: number, f: number, rnd: () => number): number {
  const tau = Math.PI * 2;
  switch (r) {
    case "kick": {
      const hz = 45 + 110 * Math.exp(-t * 28);
      return Math.sin(tau * hz * t);
    }
    case "tom":
      return Math.sin(tau * f * (1 + 0.5 * Math.exp(-t * 20)) * t);
    case "snare":
      return 0.6 * rnd() + 0.5 * Math.sin(tau * 190 * t);
    case "hat":
    case "cymbal":
      return rnd() * (rnd() > 0 ? 1 : 0.6);
    case "clap":
      return rnd() * (Math.sin(tau * 90 * t) > 0 ? 1 : 0.35);
    case "bass":
      return Math.sin(tau * f * t) + 0.4 * Math.sin(tau * 2 * f * t);
    case "lead":
      return Math.sin(tau * f * t) > 0 ? 0.6 : -0.6;
    case "pluck":
      return (
        Math.sin(tau * f * t) +
        0.5 * Math.sin(tau * 2 * f * t) * Math.exp(-t * 6)
      );
    case "keys":
      return Math.sin(tau * f * t) + 0.3 * Math.sin(tau * 3 * f * t);
    case "choir":
    case "pad":
      return (
        Math.sin(tau * f * t) +
        0.6 * Math.sin(tau * f * 1.5 * t) +
        0.4 * Math.sin(tau * f * 2.003 * t)
      );
    case "wind":
      return Math.sin(tau * f * t) * 0.7 + rnd() * 0.15;
    default:
      return (
        [1, 1.26, 1.5].reduce((sum, k) => sum + Math.sin(tau * f * k * t), 0) /
        2
      );
  }
}

function levels(r: Recipe, t: number, dur: number): number {
  const sustained =
    r === "pad" || r === "choir" || r === "wind" || r === "lead";
  if (sustained) {
    const attack = Math.min(1, t / 0.08);
    const release = Math.min(1, (dur - t) / 0.1);
    return Math.max(0, attack * release);
  }
  const fixed: Partial<Record<Recipe, number>> = { cymbal: 2.4, hat: 40 };
  return Math.exp(-t * (fixed[r] ?? 6 / Math.max(0.15, dur)));
}

/** The mono audio of a fixture sound. */
function fixtureAudio(spec: Spec): Float32Array {
  const frames = Math.round(spec.dur * RATE);
  const rnd = noise(spec.id);
  const f = hzOf(spec.note, spec.recipe === "tom" ? 120 : 220);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const t = i / RATE;
    out[i] =
      0.7 * voice(spec.recipe, t, f, rnd) * levels(spec.recipe, t, spec.dur);
  }
  return out;
}

function wavBytes(data: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + data.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) {
      view.setUint8(at + i, s.charCodeAt(i));
    }
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + data.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, data.length * 2, true);
  data.forEach((v, i) => {
    view.setInt16(
      44 + i * 2,
      Math.round(Math.max(-1, Math.min(1, v)) * 32_767),
      true
    );
  });
  return bytes;
}

function waveformPng(data: Float32Array): Uint8Array<ArrayBuffer> {
  const width = 180;
  const height = 48;
  const px = new Uint8Array(width * height * 4);
  const per = Math.max(1, Math.floor(data.length / width));
  for (let x = 0; x < width; x += 1) {
    let peak = 0;
    for (let i = x * per; i < Math.min(data.length, (x + 1) * per); i += 1) {
      peak = Math.max(peak, Math.abs(data[i] ?? 0));
    }
    const half = Math.max(1, Math.round(peak * (height / 2 - 1)));
    for (let y = height / 2 - half; y < height / 2 + half; y += 1) {
      const at = (y * width + x) * 4;
      px[at] = 255;
      px[at + 1] = 138;
      px[at + 2] = 36;
      px[at + 3] = 255;
    }
  }
  return new Uint8Array(encodePng({ data: px, height, width }));
}

/* ---------- the API ---------- */

const dirOf = (id: number): number => Math.floor(id / 1000);
const userIdOf = (spec: Spec): number => 5_000_000 + (spec.id % 9973);

/** A sound as the API returns it with every field (the caller keeps the ones `fields` names). */
function rawSound(spec: Spec): Record<string, unknown> {
  const uid = userIdOf(spec);
  const cdn = "https://cdn.freesound.org";
  const preview = (q: string, ext: string): string =>
    `${cdn}/previews/${dirOf(spec.id)}/${spec.id}_${uid}-${q}.${ext}`;
  return {
    avg_rating: spec.rating,
    category: spec.category ?? IS,
    description: `${spec.name}. A fixture sound made up for tests.`,
    duration: spec.dur,
    id: spec.id,
    images: {
      spectral_l: `${cdn}/displays/${dirOf(spec.id)}/${spec.id}_${uid}_spec_L.jpg`,
      spectral_m: `${cdn}/displays/${dirOf(spec.id)}/${spec.id}_${uid}_spec_M.jpg`,
      waveform_l: `${cdn}/displays/${dirOf(spec.id)}/${spec.id}_${uid}_wave_L.png`,
      waveform_m: `${cdn}/displays/${dirOf(spec.id)}/${spec.id}_${uid}_wave_M.png`,
    },
    license: spec.license,
    loopable: spec.loop ?? false,
    name: spec.name,
    note_confidence: spec.note ? 0.9 : 0.1,
    note_name: spec.note ?? "A4",
    num_downloads: spec.dl,
    num_ratings: spec.ratings,
    previews: {
      "preview-hq-mp3": preview("hq", "mp3"),
      "preview-hq-ogg": preview("hq", "ogg"),
      "preview-lq-mp3": preview("lq", "mp3"),
      "preview-lq-ogg": preview("lq", "ogg"),
    },
    single_event: spec.single,
    subcategory: spec.sub,
    tags: spec.tags,
    url: `https://freesound.org/people/${spec.user}/sounds/${spec.id}/`,
    username: spec.user,
  };
}

function pick(
  raw: Record<string, unknown>,
  fields: string | null
): Record<string, unknown> {
  if (!fields) {
    return {
      id: raw.id,
      license: raw.license,
      name: raw.name,
      tags: raw.tags,
      username: raw.username,
    };
  }
  const out: Record<string, unknown> = {};
  for (const name of fields.split(",")) {
    if (name in raw) {
      out[name] = raw[name];
    }
  }
  return out;
}

const quoted = (text: string): string[] =>
  [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");

/** Does the sound pass the filter string the handler builds? Only that shape is understood. */
function passes(spec: Spec, filter: string): boolean {
  const clause = (name: string): string | null => {
    const m = new RegExp(
      `${name}:(\\([^)]*\\)|"[^"]*"|\\[[^\\]]*\\]|\\S+)`
    ).exec(filter);
    return m?.[1] ?? null;
  };
  const category = clause("category");
  if (category && quoted(category)[0] !== (spec.category ?? IS)) {
    return false;
  }
  const sub = clause("subcategory");
  if (sub && quoted(sub)[0] !== spec.sub) {
    return false;
  }
  const license = clause("license");
  if (license) {
    const allowed = quoted(license);
    const loose =
      allowed.includes("Attribution") &&
      spec.license === "Attribution NonCommercial";
    if (!(allowed.includes(spec.license) || loose)) {
      return false;
    }
  }
  const tag = clause("tag");
  if (tag && !quoted(tag).every((t) => spec.tags.includes(t))) {
    return false;
  }
  const dur = clause("duration");
  const max = dur
    ? Number(DURATION_MAX.exec(dur)?.[1])
    : Number.POSITIVE_INFINITY;
  if (spec.dur > max) {
    return false;
  }
  if (clause("single_event") === "true" && !spec.single) {
    return false;
  }
  return !(clause("num_ratings") && spec.ratings < 3);
}

const SORTERS: Record<string, (a: Spec, b: Spec) => number> = {
  downloads_desc: (a, b) => b.dl - a.dl,
  duration_asc: (a, b) => a.dur - b.dur,
  rating_desc: (a, b) => b.rating - a.rating,
  score: (a, b) => a.id - b.id,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

export interface FixtureCall {
  authorization: string | null;
  url: string;
}

/**
 * A `fetch` that answers like freesound.org and its CDN from the fixtures above. `calls` records every request, so a
 * test can check the URL and the Authorization header the handler built.
 */
export function createFixtureFetch(key = FIXTURE_KEY): {
  calls: FixtureCall[];
  fetch: typeof fetch;
} {
  const calls: FixtureCall[] = [];
  const fakeFetch = (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ authorization, url: url.href });
    return Promise.resolve(answer(url, authorization, key));
  };
  return { calls, fetch: fakeFetch as typeof fetch };
}

function answer(url: URL, authorization: string | null, key: string): Response {
  if (url.hostname === "cdn.freesound.org") {
    const m = CDN_ID.exec(url.pathname);
    const spec = FIXTURE_SPECS.find((s) => s.id === Number(m?.[1]));
    if (!spec) {
      return new Response("not found", { status: 404 });
    }
    const audio = fixtureAudio(spec);
    return url.pathname.endsWith(".mp3")
      ? new Response(wavBytes(audio), {
          headers: { "content-type": "audio/mpeg" },
        })
      : new Response(waveformPng(audio), {
          headers: { "content-type": "image/png" },
        });
  }
  if (authorization !== `Token ${key}`) {
    return jsonResponse(401, { detail: "Invalid token." });
  }
  if (url.pathname === "/apiv2/search/") {
    return searchAnswer(url);
  }
  const m = API_SOUND_PATH.exec(url.pathname);
  const spec = FIXTURE_SPECS.find((s) => s.id === Number(m?.[1]));
  if (!(m && spec)) {
    return jsonResponse(404, { detail: "Not found." });
  }
  return jsonResponse(
    200,
    pick(rawSound(spec), url.searchParams.get("fields"))
  );
}

function searchAnswer(url: URL): Response {
  const p = url.searchParams;
  const words = (p.get("query") ?? "").toLowerCase().split(" ").filter(Boolean);
  const sorter = SORTERS[p.get("sort") ?? "score"] ?? SORTERS.score;
  const hits = FIXTURE_SPECS.filter(
    (s) =>
      passes(s, p.get("filter") ?? "") &&
      words.every((w) =>
        `${s.name} ${s.tags.join(" ")}`.toLowerCase().includes(w)
      )
  ).sort(sorter as (a: Spec, b: Spec) => number);
  const size = Number(p.get("page_size") ?? 15);
  const page = Number(p.get("page") ?? 1);
  const slice = hits.slice((page - 1) * size, page * size);
  const more = page * size < hits.length;
  return jsonResponse(200, {
    count: hits.length,
    next: more ? `${url.origin}${url.pathname}?page=${page + 1}` : null,
    previous: page > 1 ? `${url.origin}${url.pathname}?page=${page - 1}` : null,
    results: slice.map((s) => pick(rawSound(s), p.get("fields"))),
  });
}
