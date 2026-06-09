// #780 — Prisma result extensions don't apply to _sum/_avg/_min/_max/groupBy,
// so aggregate money reads still surface bigint. Every aggregation site funnels
// through here; the safe-range assert catches the (never-expected) day a sum
// exceeds 2^53-1 paise instead of silently losing precision.
export function sumPaise(v: bigint | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`money value outside Number safe range: ${v}`);
  }
  return n;
}
