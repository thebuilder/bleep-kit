/** The entry of `list` closest to `target` (the first one on a tie); `target` itself when the list is empty. */
export function nearest(list: readonly number[], target: number): number {
  let best = list[0] ?? target;
  for (const c of list) {
    if (Math.abs(c - target) < Math.abs(best - target)) {
      best = c;
    }
  }
  return best;
}
