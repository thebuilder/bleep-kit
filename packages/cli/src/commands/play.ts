import { CliError } from "../output.ts";
import { openProject, parseRef, resolveRef } from "../project.ts";
import type { CommandSpec } from "./types.ts";

const TRAILING_SLASHES_RE = /\/+$/;

export const DEFAULT_STUDIO = "http://localhost:5174";

export const playCommand: CommandSpec = {
  description:
    "Asks a running studio (start one with `bleepkit studio`) to play a document through its audio engine, in the " +
    "browser tab that is open on it. Exits 4 when no studio answers. `clients` in the result is how many browser tabs " +
    "received the request: 0 means the server runs but nobody is listening. --visual also starts the studio's visuals.",
  examples: [
    "bleepkit play sfx/coin",
    "bleepkit play song/title --visual --studio http://localhost:5174",
  ],
  flags: [
    {
      default: DEFAULT_STUDIO,
      description: "studio server address",
      name: "studio",
      type: "string",
      valueName: "<url>",
    },
    {
      description: "also run the studio's visuals",
      name: "visual",
      type: "boolean",
    },
  ],
  name: "play",
  noProject: true,
  run: async (ctx, args) => {
    const [refArg] = args.positionals;
    if (!refArg) {
      throw new CliError("usage", "play needs a document reference", {
        hint: "Example: bleepkit play sfx/coin",
      });
    }
    let ref: string;
    const parsed = parseRef(refArg);
    try {
      const pc = openProject(ctx);
      ({ ref } = resolveRef(pc, refArg, ["sfx", "song", "instrument"]));
    } catch (error) {
      if (
        error instanceof CliError &&
        error.code === "no-project" &&
        parsed.kind
      ) {
        ref = `${parsed.kind}/${parsed.id}`;
      } else {
        throw error;
      }
    }
    const studio = (args.str("studio") ?? DEFAULT_STUDIO).replace(
      TRAILING_SLASHES_RE,
      ""
    );
    let response: Response;
    try {
      response = await fetch(`${studio}/api/play`, {
        body: JSON.stringify({ ref, visual: args.bool("visual") ?? false }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(4000),
      });
    } catch (error) {
      throw new CliError("not-found", `no studio answered at ${studio}`, {
        cause: error,
        hint: "Start one with `bleepkit studio` (add --port to change the port), open the printed URL in a browser, then retry. Use --studio <url> if it runs elsewhere.",
      });
    }
    let body: {
      clients?: number;
      error?: string;
      message?: string;
      ok?: boolean;
    } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // not JSON: not our studio
    }
    if (!(response.ok && body.ok)) {
      throw new CliError(
        response.status === 404 ? "not-found" : "invalid",
        `studio at ${studio} refused the request (${response.status}): ${body.message ?? body.error ?? "unexpected response"}`,
        {
          hint: "Check that --studio points at a `bleepkit studio` server (GET /api/health should answer).",
        }
      );
    }
    const clients = body.clients ?? 0;
    return {
      human:
        clients > 0
          ? `Playing ${ref} in ${clients} studio tab${clients === 1 ? "" : "s"} at ${studio}`
          : `Studio at ${studio} has no browser tab open, so nothing played. Open ${studio} in a browser and retry.`,
      json: { clients, ok: true, ref, studio },
    };
  },
  summary: "play a document in a running studio",
  usage: "play <ref> [--studio http://localhost:5174] [--visual]",
};
