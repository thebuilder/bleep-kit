/* Shared by the Freesound client tests: the page's fetches of /api/freesound/* answered by the real handler, with the
   fixtures (server/freesound/fixtures.ts) standing in for freesound.org. */
import { vi } from "vitest";
import { createFixtureFetch } from "../server/freesound/fixtures.ts";
import { handleFreesound } from "../server/freesound/handler.ts";
import { createLimitState } from "../server/freesound/limits.ts";

/** The studio's origin as the page sees it. */
export const ORIGIN = "https://studio.test";

export /** Route fetch into the handler; returns the URLs asked for, in order. `env` holds the key, or not. */
function serve(env: { FREESOUND_CLIENT_SECRET?: string }): string[] {
  const asked: string[] = [];
  const fixture = createFixtureFetch();
  const deps = {
    env,
    fetch: fixture.fetch,
    limits: createLimitState(),
    now: () => Date.now(),
  };
  vi.stubGlobal("fetch", (input: string) => {
    asked.push(input);
    return handleFreesound(new Request(new URL(input, ORIGIN)), deps);
  });
  return asked;
}
