/* The environment the function reads: only the Freesound API key. `FREESOUND_CLIENT_SECRET` is the "Client secret/Api
   key" of the Freesound API application, which the API accepts as the token (docs: Authentication). The client id is
   for OAuth2 and is not used. */

export interface FreesoundEnv {
  FREESOUND_CLIENT_ID?: string | undefined;
  FREESOUND_CLIENT_SECRET?: string | undefined;
}

/** `process.env` where there is one (a Vercel Function, Vite, the CLI), nothing in a browser or a test. */
export function processEnv(): FreesoundEnv {
  const proc = (globalThis as { process?: { env?: FreesoundEnv } }).process;
  return proc?.env ?? {};
}

/** The API key, or null when the server is not set up for Freesound. */
export function apiKey(env: FreesoundEnv): string | null {
  const key = env.FREESOUND_CLIENT_SECRET?.trim();
  return key ? key : null;
}
