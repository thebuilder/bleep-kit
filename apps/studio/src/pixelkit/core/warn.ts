/* Warnings that should not flood the console: each message is printed once per run. */
const warned = new Set<string>();
/** The console, wherever the core runs (it is built without DOM or Node types). */
const out = (globalThis as { console?: { warn(m: string): void } }).console;
/** console.warn a message once per run. */
export function warnOnce(message: string): void {
  if (!warned.has(message)) {
    warned.add(message);
    out?.warn(message);
  }
}
