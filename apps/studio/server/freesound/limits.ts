/* Rate limits for a function that spends one shared Freesound key. Freesound allows 60 requests per minute and 2000 per
   day per API key (https://freesound.org/docs/api/overview.html), and every visitor of the studio uses the same key,
   so two things are counted: each visitor's requests (by IP address), and the calls this instance makes to the API.
   The counters live in memory, so they are per function instance and a cold start resets them: they stop one
   visitor or one runaway loop, while the CDN cache (Cache-Control on every answer) is what keeps the real number of
   API calls low. A Vercel Firewall rate limit rule on /api/freesound is the account wide backstop. */

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Per IP address and minute. Searches and sound lookups spend API calls; media only reads the CDN. */
export const IP_LIMITS = {
  media: 300,
  search: 15,
  sound: 15,
} as const;

/** This instance's budget of API calls: under Freesound's 60 per minute and 2000 per day. */
export const API_BUDGET = { perDay: 1800, perMinute: 50 } as const;

export type LimitKind = keyof typeof IP_LIMITS;

export interface LimitState {
  apiDay: { count: number; start: number };
  apiMinute: number[];
  ips: Map<string, number[]>;
}

export function createLimitState(): LimitState {
  return { apiDay: { count: 0, start: 0 }, apiMinute: [], ips: new Map() };
}

/** Keep only the timestamps inside the window. */
function prune(stamps: number[], now: number, window: number): void {
  while (stamps.length > 0 && (stamps[0] ?? 0) <= now - window) {
    stamps.shift();
  }
}

/** Seconds until the oldest timestamp leaves the window. */
const waitSeconds = (stamps: number[], now: number, window: number): number =>
  Math.max(1, Math.ceil(((stamps[0] ?? now) + window - now) / 1000));

/** Count one request from `ip`. Returns the seconds to wait when the visitor is over the limit, else 0. */
export function takeIp(
  state: LimitState,
  ip: string,
  kind: LimitKind,
  now: number
): number {
  const key = `${kind}:${ip}`;
  const stamps = state.ips.get(key) ?? [];
  prune(stamps, now, MINUTE);
  if (stamps.length >= IP_LIMITS[kind]) {
    state.ips.set(key, stamps);
    return waitSeconds(stamps, now, MINUTE);
  }
  stamps.push(now);
  state.ips.set(key, stamps);
  if (state.ips.size > 5000) {
    sweep(state, now);
  }
  return 0;
}

/** Forget visitors with no request in the last minute, so the map cannot grow without bound. */
function sweep(state: LimitState, now: number): void {
  for (const [key, stamps] of state.ips) {
    prune(stamps, now, MINUTE);
    if (stamps.length === 0) {
      state.ips.delete(key);
    }
  }
}

/** Count one call to the Freesound API. Returns the seconds to wait when the budget is spent, else 0. */
export function takeApi(state: LimitState, now: number): number {
  if (now - state.apiDay.start >= DAY) {
    state.apiDay = { count: 0, start: now };
  }
  if (state.apiDay.count >= API_BUDGET.perDay) {
    return Math.ceil((state.apiDay.start + DAY - now) / 1000);
  }
  prune(state.apiMinute, now, MINUTE);
  if (state.apiMinute.length >= API_BUDGET.perMinute) {
    return waitSeconds(state.apiMinute, now, MINUTE);
  }
  state.apiMinute.push(now);
  state.apiDay.count += 1;
  return 0;
}
