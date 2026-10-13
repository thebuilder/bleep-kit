/* The import dialog behind the Samples section's import button and the "Search Freesound samples" command: two tabs,
   "From file" (the system file picker, as before) and "From Freesound" (the sample browser, panel.ts). */
import { decodeAudioBytes } from "../lib/audio-decode.ts";
import { CHIP_THEME } from "../lib/chips.ts";
import { fire, h, prefs } from "../lib/dom.ts";
import { playPreviewSample, stopEverything } from "../playback.ts";
import { project } from "../state/docs.ts";
import { pickAudioFiles } from "../ui/import-audio.ts";
import { openModal } from "../ui/modal.ts";
import { fetchPreviewBytes } from "./api.ts";
import { type UseMode, useSound } from "./import.ts";
import { createFreesoundPanel } from "./panel.ts";
import { PreviewPlayer } from "./preview.ts";

export type ImportTab = "file" | "freesound";

const TAB_KEY = "sample-import-tab";

/** The previews play through the studio's engine; the decoded ones are kept while the dialog is open. */
function createPreviewPlayer(): PreviewPlayer {
  return new PreviewPlayer({
    decode: decodeAudioBytes,
    fetchBytes: fetchPreviewBytes,
    play: (sample) => {
      playPreviewSample(sample);
    },
    stop: stopEverything,
  });
}

/** Open the sample import dialog on a tab (default: the one used last). */
export function openSampleImport(tab?: ImportTab): void {
  const first: ImportTab = tab ?? prefs.get<ImportTab>(TAB_KEY, "file");
  const player = createPreviewPlayer();
  const tabs = h("div", { class: "fs-tabs", role: "tablist" });
  const pane = h("div", { class: "fs-pane" });
  let close: () => void = () => undefined;
  let panel: ReturnType<typeof createFreesoundPanel> | null = null;

  const fileTab = (): HTMLElement =>
    h(
      "div",
      { class: "fs-file" },
      h(
        "p",
        {},
        "Import a WAV, MP3 or OGG recording as a sample. It is converted for the project's chip and opened in the sample editor."
      ),
      h(
        "button",
        {
          class: "btn primary big",
          onclick: () => {
            close();
            pickAudioFiles();
          },
          type: "button",
        },
        "Choose audio files"
      ),
      h(
        "p",
        { class: "muted" },
        "You can also drop audio files anywhere on the studio."
      )
    );

  const onUse = (
    sound: Parameters<typeof useSound>[0],
    mode: UseMode
  ): void => {
    fire(
      useSound(sound, player, mode).then((used) => {
        if (used) {
          close();
        }
      })
    );
  };

  function show(which: ImportTab): void {
    prefs.set(TAB_KEY, which);
    panel?.dispose();
    panel = null;
    player.stop();
    for (const b of tabs.children) {
      const on = (b as HTMLElement).dataset.tab === which;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    }
    if (which === "file") {
      pane.replaceChildren(fileTab());
      return;
    }
    panel = createFreesoundPanel({
      chipLabel: () => CHIP_THEME[project.project.chip].short,
      onUse,
      player,
    });
    pane.replaceChildren(panel.el);
    panel.focus();
  }

  for (const [id, label] of [
    ["file", "From file"],
    ["freesound", "From Freesound"],
  ] as const) {
    tabs.append(
      h(
        "button",
        {
          "aria-selected": "false",
          class: "fs-tab",
          "data-tab": id,
          onclick: () => show(id),
          role: "tab",
          type: "button",
        },
        label
      )
    );
  }
  close = openModal(
    h(
      "div",
      { class: "fs-dialog" },
      h(
        "div",
        { class: "fs-head" },
        h("h2", { class: "pxh" }, "Import a sample"),
        tabs
      ),
      pane
    ),
    {
      cls: "fs-modal",
      onClose: () => {
        panel?.dispose();
        player.stop();
        player.clear();
      },
    }
  );
  show(first);
}
