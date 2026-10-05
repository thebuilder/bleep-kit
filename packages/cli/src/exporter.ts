// `bleepkit export`: render what is stale, encode to the project's export formats, write the game's audio folder, the
// typed audio.ts and manifest.json (architecture.md sections 7 and 8). Shared with the studio server's /api/export.
import fs from "node:fs";
import path from "node:path";
import type {
  AudioManifest,
  Issue,
  ManifestSfx,
  ManifestSong,
  Sfx,
  Song,
} from "@bleepkit/core";
import { decodeWav } from "@bleepkit/core/tools";
import {
  MP3_LOOP_WARNING,
  manifestJson,
  manifestTs,
  mp3Shift,
  seconds,
  sortedRecord,
} from "./manifest.ts";
import { CliError } from "./output.ts";
import {
  instrumentsFor,
  listIdsValid,
  loadDoc,
  type ProjectCtx,
  sha1Hex,
  toPosix,
  writeFileAtomic,
} from "./project.ts";
import {
  type AudioFormat,
  encodeAs,
  encoderSetting,
  freshness,
  outBase,
  readMeta,
  recordExport,
  renderDoc,
} from "./render.ts";

export interface ExportOptions {
  clean?: boolean;
  /** Absolute path overriding export.dir. */
  dir?: string;
  dryRun?: boolean;
  embed?: boolean;
  /** Absolute path overriding export.manifest. */
  manifest?: string;
  musicFormat?: AudioFormat;
  sfxFormat?: AudioFormat;
}

export interface ExportResult {
  dryRun: boolean;
  /** Project relative path of audio.ts. */
  manifest: string;
  ok: true;
  removed: string[];
  /** Documents that had to be re-rendered (or would be, in a dry run). */
  rendered: string[];
  root: string;
  /** Documents whose exported file was already current. */
  upToDate: string[];
  warnings: string[];
  written: string[];
}

interface Target {
  id: string;
  kind: "sfx" | "song";
}

function relToRoot(pc: ProjectCtx, abs: string): string {
  return toPosix(path.relative(pc.root, abs));
}

function sameContent(abs: string, data: string | Uint8Array): boolean {
  try {
    const existing = fs.readFileSync(abs);
    const next =
      typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    return existing.equals(next);
  } catch {
    return false;
  }
}

function collectTargets(pc: ProjectCtx): Target[] {
  const targets: Target[] = [
    ...listIdsValid(pc.root, "sfx").map((id) => ({ id, kind: "sfx" as const })),
    ...listIdsValid(pc.root, "song").map((id) => ({
      id,
      kind: "song" as const,
    })),
  ];
  const sfxIds = new Set(
    targets.filter((t) => t.kind === "sfx").map((t) => t.id)
  );
  const clash = targets
    .filter((t) => t.kind === "song" && sfxIds.has(t.id))
    .map((t) => t.id);
  if (clash.length > 0) {
    throw new CliError(
      "invalid",
      `sfx and song share the id ${clash.map((c) => `"${c}"`).join(", ")}: both would export to ${clash[0]}.<ext>`,
      {
        hint: "Rename one of the documents (rename the .json file) so every id is unique across sfx and songs.",
      }
    );
  }
  return targets;
}

function checkAllValid(pc: ProjectCtx, targets: Target[]): void {
  const problems: { issues: Issue[]; ref: string }[] = [];
  for (const t of targets) {
    const doc = loadDoc(pc, t.kind, t.id);
    if (!doc.ok) {
      problems.push({ issues: doc.issues, ref: doc.ref });
    }
  }
  if (problems.length > 0) {
    const lines = problems.flatMap((p) => [
      `${p.ref}:`,
      ...p.issues
        .filter((i) => i.severity === "error")
        .map((i) => `  ${i.path || "/"}: ${i.message}`),
    ]);
    throw new CliError(
      "invalid",
      `cannot export: ${problems.length} document${problems.length === 1 ? "" : "s"} with errors\n${lines.join("\n")}`,
      {
        details: { problems },
        hint: "Fix them (see `bleepkit validate`), then export again. Nothing was written.",
      }
    );
  }
}

const GENERATED_AUDIO = /\.(wav|ogg|mp3)$/;

/** Everything one export run accumulates while it walks the documents. */
interface Run {
  dir: string;
  dryRun: boolean;
  embed: boolean;
  expected: Set<string>;
  log: (text: string) => void;
  /** True once a target's render does not exist yet, so manifest durations are unknown (dry run). */
  manifestUnknown: boolean;
  mp3Song: boolean;
  musicFormat: AudioFormat;
  pc: ProjectCtx;
  rendered: string[];
  sfx: Record<string, ManifestSfx>;
  sfxFormat: AudioFormat;
  songs: Record<string, ManifestSong>;
  upToDate: string[];
  wantEvents: boolean;
  warnings: string[];
  written: string[];
}

function formatOf(x: Run, t: Target): AudioFormat {
  return t.kind === "sfx" ? x.sfxFormat : x.musicFormat;
}

/** Dry run: decide from the sidecars alone what would be rendered and written. */
function planTarget(x: Run, t: Target): void {
  const { pc } = x;
  const ref = `${t.kind}/${t.id}`;
  const format = formatOf(x, t);
  const fileName = `${t.id}.${format}`;
  const dest = path.join(x.dir, fileName);
  const destRel = relToRoot(pc, dest);
  const fresh = freshness(pc, t.kind, t.id) === "fresh";
  const meta = readMeta(pc, t.kind, t.id);
  if (!fresh) {
    x.rendered.push(ref);
    x.manifestUnknown = true;
  }
  const current =
    fresh &&
    meta !== null &&
    fs.existsSync(dest) &&
    meta.exports[destRel] ===
      sha1Hex(`${meta.hash}:${encoderSetting(pc, format)}`);
  if (current) {
    x.upToDate.push(ref);
  } else {
    x.written.push(destRel);
  }
  if (t.kind === "song" && x.wantEvents && !fresh) {
    x.written.push(relToRoot(pc, path.join(x.dir, `${t.id}.events.json`)));
  }
  if (t.kind === "sfx") {
    x.sfx[t.id] = { duration: meta?.duration ?? 0, file: fileName };
  } else {
    x.songs[t.id] = {
      duration: meta?.duration ?? 0,
      file: fileName,
      loopEnd: meta?.loopEnd ?? null,
      loopStart: meta?.loopStart ?? null,
    };
  }
}

async function writeAudioFile(
  x: Run,
  t: Target,
  entry: { master: string },
  meta: { hash: string },
  dest: string,
  format: AudioFormat
): Promise<void> {
  const { pc } = x;
  const destRel = relToRoot(pc, dest);
  const setting = sha1Hex(`${meta.hash}:${encoderSetting(pc, format)}`);
  const current = readMeta(pc, t.kind, t.id);
  if (current?.exports[destRel] === setting && fs.existsSync(dest)) {
    x.upToDate.push(`${t.kind}/${t.id}`);
    return;
  }
  const masterBytes = new Uint8Array(
    fs.readFileSync(path.join(pc.root, entry.master))
  );
  const bytes =
    format === "wav"
      ? masterBytes
      : await encodeAs(pc, decodeWav(masterBytes), format);
  writeFileAtomic(dest, bytes);
  recordExport(pc, t.kind, t.id, destRel, setting);
  x.written.push(destRel);
}

function copyEvents(x: Run, t: Target): void {
  const src = path.join(x.pc.root, `${outBase(t.kind, t.id)}.events.json`);
  const dest = path.join(x.dir, `${t.id}.events.json`);
  const text = fs.readFileSync(src, "utf8");
  if (!sameContent(dest, text)) {
    writeFileAtomic(dest, text);
    x.written.push(relToRoot(x.pc, dest));
  }
}

function recordManifestEntry(
  x: Run,
  t: Target,
  meta: {
    duration: number;
    loopEnd: number | null;
    loopStart: number | null;
    rate: number;
  },
  fileName: string,
  format: AudioFormat
): void {
  const doc = loadDoc(x.pc, t.kind, t.id);
  if (t.kind === "sfx") {
    x.sfx[t.id] = {
      duration: seconds(meta.duration),
      ...(x.embed ? { data: doc.value as Sfx } : {}),
      file: fileName,
    };
    return;
  }
  // MP3 decoders add encoder delay at the start, so the loop points move by it
  const shift = format === "mp3" ? mp3Shift(meta.rate) : 0;
  const song = doc.value as Song;
  x.songs[t.id] = {
    ...(x.embed
      ? { data: { instruments: instrumentsFor(x.pc, song), song } }
      : {}),
    duration: seconds(meta.duration),
    ...(x.wantEvents ? { events: `${t.id}.events.json` } : {}),
    file: fileName,
    loopEnd: meta.loopEnd === null ? null : seconds(meta.loopEnd + shift),
    loopStart: meta.loopStart === null ? null : seconds(meta.loopStart + shift),
  };
}

async function exportTarget(x: Run, t: Target): Promise<void> {
  const { pc } = x;
  const ref = `${t.kind}/${t.id}`;
  const format = formatOf(x, t);
  const fileName = `${t.id}.${format}`;
  x.expected.add(fileName);
  if (t.kind === "song" && x.wantEvents) {
    x.expected.add(`${t.id}.events.json`);
  }
  if (x.dryRun) {
    planTarget(x, t);
    return;
  }
  const entry = await renderDoc(pc, t.kind, t.id, {}, { log: x.log });
  if (!entry.cached) {
    x.rendered.push(ref);
  }
  if (entry.clipped) {
    x.warnings.push(
      `${ref} clips (${entry.clippedFrames} frames at full scale): lower its volume`
    );
  }
  const meta = readMeta(pc, t.kind, t.id);
  if (!meta) {
    throw new CliError("write", `render sidecar missing for ${ref}`);
  }
  await writeAudioFile(x, t, entry, meta, path.join(x.dir, fileName), format);
  if (t.kind === "song" && x.wantEvents) {
    copyEvents(x, t);
  }
  if (t.kind === "song" && format === "mp3") {
    x.mp3Song = true;
  }
  recordManifestEntry(x, t, meta, fileName, format);
}

function writeManifests(x: Run, manifestPath: string): void {
  const manifest: AudioManifest = {
    base: x.pc.project.export.baseUrl,
    sampleRate: x.pc.project.sampleRate,
    sfx: sortedRecord(x.sfx),
    songs: sortedRecord(x.songs),
  };
  const outputs: [string, string][] = [
    [manifestPath, manifestTs(manifest)],
    [path.join(x.dir, "manifest.json"), manifestJson(manifest)],
  ];
  for (const [abs, text] of outputs) {
    if (x.dryRun && x.manifestUnknown) {
      x.written.push(relToRoot(x.pc, abs));
    } else if (!sameContent(abs, text)) {
      if (!x.dryRun) {
        writeFileAtomic(abs, text);
      }
      x.written.push(relToRoot(x.pc, abs));
    }
  }
}

function cleanDir(x: Run): string[] {
  const removed: string[] = [];
  if (!fs.existsSync(x.dir)) {
    return removed;
  }
  for (const name of fs.readdirSync(x.dir)) {
    const generated =
      GENERATED_AUDIO.test(name) || name.endsWith(".events.json");
    if (generated && !x.expected.has(name)) {
      const abs = path.join(x.dir, name);
      if (!x.dryRun) {
        fs.rmSync(abs, { force: true });
      }
      removed.push(relToRoot(x.pc, abs));
    }
  }
  return removed;
}

export async function runExport(
  pc: ProjectCtx,
  options: ExportOptions = {},
  log: (text: string) => void = () => undefined
): Promise<ExportResult> {
  const exp = pc.project.export;
  const manifestPath = options.manifest ?? path.resolve(pc.root, exp.manifest);
  const targets = collectTargets(pc);
  checkAllValid(pc, targets);
  const x: Run = {
    dir: options.dir ?? path.resolve(pc.root, exp.dir),
    dryRun: options.dryRun ?? false,
    embed: options.embed ?? exp.embed,
    expected: new Set(["manifest.json"]),
    log,
    manifestUnknown: false,
    mp3Song: false,
    musicFormat: options.musicFormat ?? exp.musicFormat,
    pc,
    rendered: [],
    sfx: {},
    sfxFormat: options.sfxFormat ?? exp.sfxFormat,
    songs: {},
    upToDate: [],
    wantEvents: exp.events,
    warnings: [],
    written: [],
  };
  for (const t of targets) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, renders are CPU bound and the log reads in document order
    await exportTarget(x, t);
  }
  if (x.mp3Song) {
    x.warnings.push(MP3_LOOP_WARNING);
  }
  if (targets.length === 0) {
    x.warnings.push(
      "the project has no sfx or songs yet: wrote an empty manifest"
    );
  }
  writeManifests(x, manifestPath);
  const removed = options.clean ? cleanDir(x) : [];
  return {
    dryRun: x.dryRun,
    manifest: relToRoot(pc, manifestPath),
    ok: true,
    removed,
    rendered: x.rendered,
    root: pc.root,
    upToDate: x.upToDate,
    warnings: x.warnings,
    written: x.written,
  };
}
