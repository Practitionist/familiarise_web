/**
 * Equal jitter: a delay in [baseMs / 2, baseMs], so clients that failed together
 * do not retry in lockstep and the ladder's upper bound stays `baseMs`.
 */
export function withJitter(
  baseMs: number,
  random: () => number = Math.random,
): number {
  return Math.round(baseMs / 2 + (random() * baseMs) / 2);
}
