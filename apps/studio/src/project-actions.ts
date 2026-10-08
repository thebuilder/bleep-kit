/* The project-level actions behind the top bar's project menu, the command palette and the Project view: start a new
   project, open or import files, download the project as a zip, export the audio for a game, start over. They work on
   the browser's own project (IndexedDB) and, where it makes sense, on a project folder through the studio server; an
   action that does not apply to the current store says why instead of failing. */
import { app, type Command } from "./app.ts";
import {
  download,
  type ExportResult,
  exportInBrowser,
} from "./export-local.ts";
import type { ChipId } from "./lib/contract.ts";
import { hashString } from "./lib/core.ts";
import { fire, prefs } from "./lib/dom.ts";
import { stopEverything } from "./playback.ts";
import { project } from "./state/docs.ts";
import type { LocalStore } from "./store/local.ts";
import { resetDialog } from "./ui/reset-dialog.ts";

const NON_ALNUM = /[^a-z0-9]+/g;

/** The project name as a file name stem. */
const slug = (): string =>
  project.project.name.toLowerCase().replace(NON_ALNUM, "-") || "bleepkit";

/** The browser's own store, or null when the project is a folder behind the studio server. */
function localStore(): LocalStore | null {
  const { store } = project;
  return store?.mode === "local" ? (store as LocalStore) : null;
}

const isEmptyProject = (): boolean =>
  project.list("sfx").length +
    project.list("song").length +
    project.list("instrument").length ===
  0;

/* ----- what is not in a zip yet ----- */

const backupKey = () => `backup:${project.root}`;

/** A hash of every document and the project settings: it changes when anything in the project changes. */
function fingerprint(): string {
  const parts = [JSON.stringify(project.project)];
  for (const d of [...project.docs.values()].sort((a, b) =>
    a.path.localeCompare(b.path)
  )) {
    parts.push(`${d.path}\n${JSON.stringify(d.value)}`);
  }
  return String(hashString(parts.join("\n")));
}

/** Remember that the project as it is now is safe: in a downloaded zip, or still the pristine starter kit. */
function markBackedUp(): void {
  prefs.set(backupKey(), fingerprint());
}

/** True when there is something to lose: the project has documents and they differ from the last zip. */
function hasUnbackedChanges(): boolean {
  return !isEmptyProject() && prefs.get(backupKey(), "") !== fingerprint();
}

/** Called after the project opens: a project the studio just filled with the starter kit has nothing to lose yet. */
export function markPristineIfSeeded(): void {
  if (localStore()?.seeded) {
    markBackedUp();
  }
}

/* ----- export ----- */

type AudioExport =
  | { mode: "browser"; res: ExportResult }
  | { mode: "server"; res: unknown };

let exporting = false;
export const audioExportBusy = (): boolean => exporting;

interface ExportHooks {
  progress?: (done: number, total: number, label: string) => void;
  /** The studio server renders on its own, with no progress to show. */
  serverStarted?: () => void;
}

/** Render and export the audio for a game: the studio server writes the files, or the browser renders and downloads a
 *  zip. Throws when there is nothing to export or an export is already running. */
export async function exportAudio(
  hooks: ExportHooks = {}
): Promise<AudioExport> {
  if (exporting) {
    throw new Error("an export is already running");
  }
  if (project.list("sfx").length + project.list("song").length === 0) {
    throw new Error(
      "nothing to export yet, add a sound effect or a song first"
    );
  }
  exporting = true;
  try {
    await project.saveAll();
    const { store } = project;
    if (store.mode === "server" && store.exportAll) {
      hooks.serverStarted?.();
      return { mode: "server", res: await store.exportAll(false) };
    }
    const res = await exportInBrowser(hooks.progress ?? (() => undefined));
    const seen: Record<string, string> = {};
    for (const d of [...project.list("sfx"), ...project.list("song")]) {
      if (d.etag) {
        seen[d.path] = d.etag;
      }
    }
    prefs.set(`exported:${project.root}`, seen);
    download(`${slug()}-audio.zip`, res.zip);
    return { mode: "browser", res };
  } finally {
    exporting = false;
  }
}

/** The menu's and palette's export: progress in the toast, then the result with a way to the details. */
async function exportAudioWithToasts(): Promise<void> {
  try {
    const out = await exportAudio({
      progress: (done, total, label) =>
        app.toast(`Exporting ${label} (${done}/${total})`),
      serverStarted: () => app.toast("The studio server is rendering"),
    });
    const text =
      out.mode === "browser"
        ? `Exported ${out.res.entries.length} files, the zip was downloaded`
        : "Export finished, the studio server wrote the files";
    app.toast(text, "Details", () => app.navigate("#/project"));
  } catch (err) {
    app.toast(`Export failed: ${(err as Error).message}`);
  }
}

/** Download the whole project (documents and settings) as a zip, to keep a copy or open elsewhere. */
export async function exportProjectZip(): Promise<void> {
  const ls = localStore();
  if (!ls) {
    return;
  }
  await project.saveAll();
  download(`${slug()}-project.zip`, await ls.exportZip());
  markBackedUp();
}

/* ----- replacing the project ----- */

/** Put a freshly filled store in front of the person: stop sound, reload, go home. */
async function reopen(ls: LocalStore): Promise<void> {
  await project.load(ls);
  app.navigate("#/pads");
}

type Replacement =
  | { kind: "empty"; name: string; chip: ChipId }
  | { kind: "starter" };

const EDITOR_VIEWS = new Set(["sfx", "song", "instrument", "analysis"]);

/** Close the editor that is open: its document is about to go, so it must not be on screen while the project loads. */
function leaveEditors(): Promise<void> {
  if (!EDITOR_VIEWS.has(app.route.view)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    // the router listens first, so the pads are mounted when this runs
    const done = () => {
      removeEventListener("hashchange", done);
      resolve();
    };
    addEventListener("hashchange", done);
    app.navigate("#/pads");
  });
}

async function replaceProject(ls: LocalStore, r: Replacement): Promise<void> {
  stopEverything();
  await leaveEditors();
  await project.saveAll();
  if (r.kind === "empty") {
    await ls.resetToEmpty(r.name, r.chip);
  } else {
    await ls.resetToStarter();
  }
  await reopen(ls);
  if (r.kind === "starter") {
    markBackedUp();
  }
}

/** New project: ask for an empty project or the starter kit, offering to download the current one first. */
async function newProject(): Promise<void> {
  const ls = localStore();
  if (!ls) {
    return;
  }
  const answer = await resetDialog({
    chip: project.project.chip,
    choose: true,
    hasChanges: hasUnbackedChanges(),
    kind: "empty",
    message: "Start a new project? What is in this browser now is replaced.",
    name: "My game",
    okLabel: "Create project",
  });
  if (!answer) {
    return;
  }
  if (answer.backup) {
    await exportProjectZip();
  }
  await replaceProject(
    ls,
    answer.kind === "empty"
      ? { chip: answer.chip, kind: "empty", name: answer.name }
      : { kind: "starter" }
  );
  app.toast(
    answer.kind === "empty"
      ? `Started ${answer.name}, an empty project`
      : "Started a new project with the starter kit"
  );
}

/** Start over: everything in this browser is replaced with the starter kit. */
export async function startOver(): Promise<void> {
  const ls = localStore();
  if (!ls) {
    return;
  }
  const answer = await resetDialog({
    chip: project.project.chip,
    hasChanges: hasUnbackedChanges(),
    kind: "starter",
    message:
      "Replace everything in this browser with the starter kit? Your own sounds and songs here will be gone.",
    name: project.project.name,
    okLabel: "Replace everything",
  });
  if (!answer) {
    return;
  }
  if (answer.backup) {
    await exportProjectZip();
  }
  await replaceProject(ls, { kind: "starter" });
  app.toast("Back to the starter kit");
}

/* ----- importing ----- */

/** Add what the files hold to the project: zips, project folders (files with a relative path) and single JSON
 *  documents. Returns how many files were taken. */
export async function importFiles(
  files: File[],
  then = "#/pads"
): Promise<number> {
  const ls = localStore();
  if (!ls) {
    return 0;
  }
  let n = 0;
  // zips go one after the other, so a later zip's document with the same id wins
  for (const f of files.filter((x) => x.name.endsWith(".zip"))) {
    // biome-ignore lint/performance/noAwaitInLoops: see above, the order is the point
    n += await ls.importZip(new Uint8Array(await f.arrayBuffer()), false);
  }
  const docs = await Promise.all(
    files
      .filter((x) => x.name.endsWith(".json"))
      .map(async (f) => {
        const rel =
          (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
          f.name;
        return ls.importEntry(rel, await f.text());
      })
  );
  n += docs.filter(Boolean).length;
  await project.load(ls);
  app.toast(
    n
      ? `Imported ${n} file${n === 1 ? "" : "s"}`
      : "Nothing in that file looked like a Bleepkit document"
  );
  app.navigate(then);
  return n;
}

/** Open the system picker for zips and JSON documents, or for a whole folder. */
function pickImport(folder: boolean): void {
  const input = document.createElement("input");
  input.type = "file";
  if (folder) {
    input.setAttribute("webkitdirectory", "");
  } else {
    input.accept = ".zip,.json,application/zip,application/json";
    input.multiple = true;
  }
  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    if (files.length) {
      fire(importFiles(files));
    }
  });
  input.click();
}

/* ----- the list of actions ----- */

interface ProjectAction {
  /** Whether it applies to the current store. */
  available: () => boolean;
  icon: string;
  id: string;
  run: () => void;
  title: string;
  /** What the tooltip says when it is not available. */
  why: string;
}

const FOLDER_WHY =
  "The project is the folder the studio server opened, so this does not apply. Start the studio on another folder to change project.";

/** The actions, in menu order. */
export function projectActions(): ProjectAction[] {
  const local = () => localStore() !== null;
  return [
    {
      available: local,
      icon: "plus",
      id: "new",
      run: () => fire(newProject()),
      title: "New project",
      why: FOLDER_WHY,
    },
    {
      available: local,
      icon: "import",
      id: "open",
      run: () => pickImport(false),
      title: "Open or import zip or JSON",
      why: "The project is a folder on disk: put files in it and they appear here at once.",
    },
    {
      available: local,
      icon: "folder",
      id: "open-folder",
      run: () => pickImport(true),
      title: "Open or import a folder",
      why: "The project is a folder on disk: put files in it and they appear here at once.",
    },
    {
      available: local,
      icon: "save",
      id: "export-zip",
      run: () => fire(exportProjectZip()),
      title: "Export project as zip",
      why: "The project already is a folder on disk, so there is nothing to zip. Use Export audio for a game.",
    },
    {
      available: () => true,
      icon: "export",
      id: "export-audio",
      run: () => fire(exportAudioWithToasts()),
      title: "Export audio for a game",
      why: "",
    },
    {
      available: local,
      icon: "refresh",
      id: "start-over",
      run: () => fire(startOver()),
      title: "Start over with the starter kit",
      why: "The project is a folder on disk, so there is nothing to reset here. Delete files from the folder instead.",
    },
  ];
}

/** The same actions for the command palette (the ones that do not apply are left out there). */
export function projectCommands(): Command[] {
  return projectActions().map((a) => ({
    enabled: a.available,
    group: "Project",
    icon: a.icon,
    id: `project:${a.id}`,
    run: a.run,
    title: a.title,
  }));
}
