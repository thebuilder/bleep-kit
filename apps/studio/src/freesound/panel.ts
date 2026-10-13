/* The Freesound sample browser: search, filter, and hear. A compact list (waveform, name, length, note, license,
   author, tags) where selecting a row plays it at once, the arrow keys move and play, Space plays again, Enter uses
   the sound. Everything goes through the studio's own /api/freesound routes (server/freesound): the browser never sees
   the key, and what it may ask for is limited to what protocol.ts lists. */
import {
  DEFAULT_QUERY,
  type FreesoundQuery,
  MAX_LENGTHS,
  type SearchResponse,
  SORTS,
  type SortId,
  SUBCATEGORIES,
  type SubcategoryId,
} from "../../server/freesound/protocol.ts";
import { debounce, fire, h, prefs } from "../lib/dom.ts";
import { icon } from "../ui/icons.ts";
import {
  FreesoundFailure,
  type FreesoundSound,
  searchSounds,
  waveformUrl,
} from "./api.ts";
import { licenseBadge } from "./badge.ts";
import type { UseMode } from "./import.ts";
import type { PreviewPlayer } from "./preview.ts";
import { tagChipsFor } from "./taxonomy.ts";

export interface PanelOptions {
  /** Name of the project's chip, for the instrument menu entry. */
  chipLabel: () => string;
  /** Called when the person chooses Use. The panel stays as it is until the caller closes it. */
  onUse: (sound: FreesoundSound, mode: UseMode) => void;
  player: PreviewPlayer;
}

export interface Panel {
  dispose: () => void;
  el: HTMLElement;
  focus: () => void;
}

const SEARCH_DELAY = 320;
const PREFETCH_AHEAD = 3;
const NEAR_BOTTOM = 240;
const PREF_KEY = "freesound:filters";
const SOURCE_URL = "https://freesound.org";

type SavedFilters = Pick<
  FreesoundQuery,
  "license" | "maxSeconds" | "oneShot" | "sort" | "sub"
>;

function savedFilters(): SavedFilters {
  const raw = prefs.get<Partial<SavedFilters>>(PREF_KEY, {});
  const known = SUBCATEGORIES.find((c) => c.id === raw.sub)?.id ?? null;
  return {
    license: raw.license === "by" ? "by" : "cc0",
    maxSeconds: MAX_LENGTHS.find((m) => m === raw.maxSeconds) ?? null,
    oneShot: raw.oneShot === true,
    sort: SORTS.find((o) => o.id === raw.sort)?.id ?? "relevance",
    sub: "sub" in raw ? known : DEFAULT_QUERY.sub,
  };
}

const seconds = (s: number): string =>
  s < 10 ? `${s.toFixed(s < 1 ? 2 : 1)} s` : `${Math.round(s)} s`;

function button(
  label: string,
  attrs: Record<string, string | boolean | ((e: Event) => void)>,
  cls = "tog"
): HTMLButtonElement {
  return h("button", { class: cls, type: "button", ...attrs }, label);
}

export function createFreesoundPanel(opts: PanelOptions): Panel {
  const { player } = opts;
  const query: FreesoundQuery = { ...DEFAULT_QUERY, ...savedFilters() };
  let results: FreesoundSound[] = [];
  let count = 0;
  let hasMore = false;
  let loading = false;
  let sel = -1;
  let ticket = 0;
  let loadedPage = 1;
  let abort: AbortController | null = null;
  let notes: string[] = [];
  let disposed = false;

  const runSoon = debounce(() => fire(runSearch(1)), 120);
  const runTyping = debounce(() => fire(runSearch(1)), SEARCH_DELAY);
  const root = h("div", { class: "fs-panel" });
  const input = h("input", {
    "aria-label": "Search Freesound",
    class: "fs-q",
    placeholder: "Search sounds: kick, laser, pad, 8-bit",
    type: "search",
  }) as HTMLInputElement;
  const subs = h("div", {
    "aria-label": "Instrument type",
    class: "fs-chips",
    role: "group",
  });
  const tags = h("div", {
    "aria-label": "Suggested tags",
    class: "fs-chips fs-tagchips",
    role: "group",
  });
  const oneShot = h("input", {
    id: "fs-oneshot",
    type: "checkbox",
  }) as HTMLInputElement;
  const byBox = h("input", {
    id: "fs-by",
    type: "checkbox",
  }) as HTMLInputElement;
  const maxSel = h("select", {
    "aria-label": "Max length",
    id: "fs-max",
  }) as HTMLSelectElement;
  const sortSel = h("select", {
    "aria-label": "Sort",
    id: "fs-sort",
  }) as HTMLSelectElement;
  const status = h("div", {
    "aria-live": "polite",
    class: "fs-status",
    role: "status",
  });
  const list = h("div", {
    "aria-label": "Sounds",
    class: "fs-list",
    role: "listbox",
    tabindex: "0",
  });
  const more = button(
    "Load more",
    { onclick: () => fire(loadMore()) },
    "btn small fs-more"
  );
  const body = h("div", { class: "fs-body" });
  const menu = h("div", { class: "fs-menu", hidden: true, role: "menu" });

  /* ----- the controls ----- */
  maxSel.append(
    h("option", { value: "" }, "Any (up to 20 s)"),
    ...MAX_LENGTHS.map((m) => h("option", { value: String(m) }, `${m} s`))
  );
  sortSel.append(...SORTS.map((s) => h("option", { value: s.id }, s.label)));
  const controls = h(
    "div",
    { class: "fs-filters" },
    h(
      "label",
      { class: "fs-check", for: "fs-oneshot" },
      oneShot,
      "One-shots only"
    ),
    h("label", { class: "fs-sel", for: "fs-max" }, "Max length", maxSel),
    h("label", { class: "fs-sel", for: "fs-sort" }, "Sort", sortSel),
    h(
      "label",
      { class: "fs-check", for: "fs-by" },
      byBox,
      "Also show CC BY (credit required)"
    )
  );

  function syncControls(): void {
    oneShot.checked = query.oneShot;
    byBox.checked = query.license === "by";
    maxSel.value = query.maxSeconds === null ? "" : String(query.maxSeconds);
    sortSel.value = query.sort;
    subs.replaceChildren(
      button("All", {
        "aria-pressed": String(query.sub === null),
        class: `tog${query.sub === null ? " on" : ""}`,
        onclick: () => setSub(null),
      }),
      ...SUBCATEGORIES.map((s) =>
        button(s.label, {
          "aria-pressed": String(query.sub === s.id),
          class: `tog${query.sub === s.id ? " on" : ""}`,
          onclick: () => setSub(s.id),
          title: s.name,
        })
      )
    );
    const chips = tagChipsFor(query.sub);
    const chosen = query.tags.filter((t) => !chips.some((c) => c.tag === t));
    tags.replaceChildren(
      ...[
        ...chips.map((c) => ({ label: c.label, tag: c.tag })),
        ...chosen.map((t) => ({ label: t, tag: t })),
      ].map((c) => {
        const on = query.tags.includes(c.tag);
        return button(c.label, {
          "aria-pressed": String(on),
          class: `tog tag${on ? " on" : ""}`,
          onclick: () => toggleTag(c.tag),
        });
      })
    );
  }

  const saveFilters = (): void => {
    const { license, maxSeconds, oneShot: one, sort, sub } = query;
    prefs.set(PREF_KEY, { license, maxSeconds, oneShot: one, sort, sub });
  };

  /** A filter changed: search now (a chip), a moment later (so a second click joins the first), or after typing stops. */
  function changed(when: "now" | "soon" | "typing"): void {
    query.page = 1;
    saveFilters();
    syncControls();
    runSoon.cancel();
    runTyping.cancel();
    if (when === "now") {
      fire(runSearch(1));
    } else {
      (when === "soon" ? runSoon : runTyping)();
    }
  }

  function setSub(sub: SubcategoryId | null): void {
    query.sub = sub;
    // a picked tag stays when the subcategory changes, so the person's pick is not lost silently
    changed("now");
  }

  function toggleTag(tag: string): void {
    query.tags = query.tags.includes(tag)
      ? query.tags.filter((t) => t !== tag)
      : [...query.tags, tag].slice(-4);
    changed("soon");
  }

  input.addEventListener("input", () => {
    query.q = input.value;
    changed("typing");
  });
  oneShot.addEventListener("change", () => {
    query.oneShot = oneShot.checked;
    changed("soon");
  });
  byBox.addEventListener("change", () => {
    query.license = byBox.checked ? "by" : "cc0";
    changed("soon");
  });
  maxSel.addEventListener("change", () => {
    query.maxSeconds = maxSel.value === "" ? null : Number(maxSel.value);
    changed("soon");
  });
  sortSel.addEventListener("change", () => {
    query.sort = sortSel.value as SortId;
    changed("soon");
  });

  /* ----- searching ----- */
  function say(text: string, tone: "" | "bad" = ""): void {
    status.textContent = text;
    status.dataset.tone = tone;
  }

  function summary(): string {
    if (results.length === 0) {
      return "No sounds match. Try fewer tags, another type or a longer max length.";
    }
    const lic = query.license === "by" ? "CC0 and CC BY" : "CC0 only";
    return `${count} sound${count === 1 ? "" : "s"}, ${lic}${notes.length > 0 ? `. ${notes.join(" ")}` : ""}`;
  }

  function showUnconfigured(failure: FreesoundFailure): void {
    body.replaceChildren(
      h(
        "div",
        { class: "fs-unavailable" },
        h(
          "h3",
          { class: "pxh" },
          failure.kind === "not-configured"
            ? "Freesound is not set up here"
            : "Freesound is not available here"
        ),
        h("p", {}, failure.message),
        failure.kind === "not-configured"
          ? h(
              "p",
              { class: "muted" },
              "The README's local setup says where the key goes. Everything else in the studio works without it."
            )
          : null,
        button("Try again", { onclick: () => fire(runSearch(1)) }, "btn small")
      )
    );
    root.dataset.unavailable = failure.kind;
  }

  /** Put a page of results into the list: the first page replaces it, a later page adds to it. */
  function applyPage(page: number, out: SearchResponse): void {
    if (root.dataset.unavailable) {
      delete root.dataset.unavailable;
      body.replaceChildren(list, h("div", { class: "fs-foot-more" }, more));
    }
    const append = page > 1;
    const from = append ? results.length : 0;
    results = append ? [...results, ...out.results] : out.results;
    loadedPage = page;
    ({ count, hasMore, notes } = out);
    if (!append) {
      sel = -1;
      list.scrollTop = 0;
    }
    renderRows(from);
  }

  /** Ask for page `page` of the current query: page 1 replaces the list, a later page adds to it. */
  async function runSearch(page: number): Promise<void> {
    if (disposed) {
      return;
    }
    const append = page > 1;
    abort?.abort();
    abort = new AbortController();
    ticket += 1;
    const mine = ticket;
    loading = true;
    if (!append) {
      say("Searching Freesound...");
    }
    try {
      const out = await searchSounds({ ...query, page }, abort.signal);
      if (mine !== ticket || disposed) {
        return;
      }
      applyPage(page, out);
      say(summary());
    } catch (error) {
      if (
        (error as Error).name === "AbortError" ||
        mine !== ticket ||
        disposed
      ) {
        return;
      }
      fail(error);
    } finally {
      if (mine === ticket) {
        loading = false;
        more.hidden = !hasMore;
        more.disabled = false;
      }
    }
  }

  function fail(error: unknown): void {
    const failure =
      error instanceof FreesoundFailure
        ? error
        : new FreesoundFailure((error as Error).message, {
            cause: error,
            kind: "failed",
          });
    if (failure.kind === "not-configured" || failure.kind === "unavailable") {
      showUnconfigured(failure);
      say("");
      return;
    }
    const wait =
      failure.kind === "rate-limited" && failure.retryAfter
        ? ` (about ${failure.retryAfter} s)`
        : "";
    say(`${failure.message}${wait}`, "bad");
  }

  async function loadMore(): Promise<void> {
    if (loading || !hasMore) {
      return;
    }
    more.disabled = true;
    await runSearch(loadedPage + 1);
  }

  /* ----- the rows ----- */
  function rowFor(sound: FreesoundSound, index: number): HTMLElement {
    const use = h(
      "span",
      { class: "fs-use" },
      button(
        "Use",
        {
          onclick: (e) => {
            e.stopPropagation();
            choose(index, "sample");
          },
          title: "Import as a sample and open it (Enter)",
        },
        "btn small primary"
      ),
      button(
        "",
        {
          "aria-haspopup": "menu",
          "aria-label": "More ways to use this sound",
          onclick: (e) => {
            e.stopPropagation();
            openMenu(index, e.currentTarget as HTMLElement);
          },
        },
        "btn small primary fs-more-btn"
      )
    );
    use.lastElementChild?.insertAdjacentHTML("beforeend", icon("down", 10));
    const img = h("img", {
      alt: "",
      class: "fs-wave",
      decoding: "async",
      height: 30,
      loading: "lazy",
      src: waveformUrl(sound),
      width: 96,
    });
    img.addEventListener("error", () => img.classList.add("none"));
    return h(
      "div",
      {
        "aria-selected": "false",
        class: "fs-row",
        "data-id": String(sound.id),
        id: `fs-row-${sound.id}`,
        onclick: () => select(index, true),
        role: "option",
      },
      img,
      h(
        "span",
        { class: "fs-main" },
        h("span", { class: "fs-name" }, sound.name),
        h("span", { class: "fs-taglist" }, sound.tags.slice(0, 5).join(" · "))
      ),
      h("span", { class: "fs-dur mono" }, seconds(sound.duration)),
      h(
        "span",
        {
          class: "fs-note mono",
          title: sound.note ? "Detected note" : "No clear note",
        },
        sound.note ?? "-"
      ),
      licenseBadge(sound.license === "cc0" ? "CC0" : "CC BY"),
      h(
        "a",
        {
          class: "fs-author",
          href: sound.url,
          onclick: (e: Event) => e.stopPropagation(),
          rel: "noopener",
          target: "_blank",
          title: `${sound.name} on Freesound.org`,
        },
        sound.author
      ),
      use
    );
  }

  function renderRows(from: number): void {
    if (from === 0) {
      list.replaceChildren();
    }
    for (let i = from; i < results.length; i += 1) {
      const sound = results[i];
      if (sound) {
        list.append(rowFor(sound, i));
      }
    }
    paintState();
  }

  function paintState(): void {
    const cur = player.current;
    results.forEach((s, i) => {
      const row = list.children[i] as HTMLElement | undefined;
      if (!row) {
        return;
      }
      row.setAttribute("aria-selected", String(i === sel));
      row.classList.toggle("sel", i === sel);
      const mine = cur?.id === s.id ? cur.state : "idle";
      row.dataset.play = mine;
    });
    const row = list.children[sel] as HTMLElement | undefined;
    if (row) {
      list.setAttribute("aria-activedescendant", row.id);
    } else {
      list.removeAttribute("aria-activedescendant");
    }
  }

  function select(index: number, play: boolean): void {
    if (results.length === 0) {
      return;
    }
    sel = Math.max(0, Math.min(results.length - 1, index));
    paintState();
    (list.children[sel] as HTMLElement | undefined)?.scrollIntoView?.({
      block: "nearest",
    });
    hideMenu();
    if (play) {
      playSelected();
    }
    player.prefetch(results.slice(sel + 1, sel + 1 + PREFETCH_AHEAD));
    if (hasMore && sel >= results.length - 4) {
      fire(loadMore());
    }
  }

  function playSelected(): void {
    const sound = results[sel];
    if (!sound) {
      return;
    }
    player.play(sound).then(
      () => undefined,
      (error: unknown) => {
        if (results[sel]?.id === sound.id) {
          say(
            `Could not play ${sound.name}: ${(error as Error).message}`,
            "bad"
          );
        }
      }
    );
  }

  function choose(index: number, mode: UseMode): void {
    const sound = results[index];
    if (sound) {
      hideMenu();
      opts.onUse(sound, mode);
    }
  }

  /* ----- the Use menu ----- */
  function hideMenu(): void {
    menu.hidden = true;
  }

  function openMenu(index: number, anchor: HTMLElement): void {
    select(index, false);
    menu.replaceChildren(
      button(
        "Use as a sample",
        { onclick: () => choose(index, "sample"), role: "menuitem" },
        "fs-menu-item"
      ),
      button(
        `Use and make an instrument for ${opts.chipLabel()}`,
        { onclick: () => choose(index, "instrument"), role: "menuitem" },
        "fs-menu-item"
      )
    );
    const box = anchor.getBoundingClientRect();
    const host = root.getBoundingClientRect();
    menu.style.top = `${box.bottom - host.top + 2}px`;
    menu.style.right = `${host.right - box.right}px`;
    menu.hidden = false;
    (menu.firstElementChild as HTMLElement | null)?.focus();
  }

  root.addEventListener("pointerdown", (e) => {
    if (
      !(
        menu.hidden ||
        menu.contains(e.target as Node) ||
        (e.target as HTMLElement).closest(".fs-more-btn")
      )
    ) {
      hideMenu();
    }
  });

  /* ----- keys ----- */
  list.addEventListener("keydown", (e) => {
    const keys: Record<string, () => void> = {
      " ": () => (sel < 0 ? select(0, true) : playSelected()),
      ArrowDown: () => select(sel + 1, true),
      ArrowUp: () => select(sel < 0 ? 0 : sel - 1, true),
      End: () => select(results.length - 1, true),
      Enter: () => choose(sel, e.shiftKey ? "instrument" : "sample"),
      Home: () => select(0, true),
      PageDown: () => select(sel + 6, true),
      PageUp: () => select(sel - 6, true),
    };
    const run = keys[e.key];
    if (run && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      run();
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && results.length > 0) {
      e.preventDefault();
      list.focus();
      select(Math.max(sel, 0), true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      query.q = input.value;
      changed("now");
    }
  });
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      hideMenu();
      list.focus();
    }
  });
  list.addEventListener("scroll", () => {
    if (
      hasMore &&
      list.scrollTop + list.clientHeight >= list.scrollHeight - NEAR_BOTTOM
    ) {
      fire(loadMore());
    }
  });
  const off = player.onChange(paintState);

  /* ----- assemble ----- */
  body.append(list, h("div", { class: "fs-foot-more" }, more));
  more.hidden = true;
  const credit = h(
    "div",
    { class: "fs-credit" },
    "Sounds from ",
    h(
      "a",
      { class: "linkish", href: SOURCE_URL, rel: "noopener", target: "_blank" },
      "Freesound.org"
    ),
    ". CC0 needs no credit; CC BY sounds are credited in the exports."
  );
  root.append(
    h("div", { class: "fs-top" }, input),
    subs,
    tags,
    controls,
    status,
    body,
    credit,
    menu
  );
  syncControls();
  fire(runSearch(1));

  return {
    dispose() {
      disposed = true;
      abort?.abort();
      runSoon.cancel();
      runTyping.cancel();
      off();
    },
    el: root,
    focus: () => input.focus(),
  };
}
