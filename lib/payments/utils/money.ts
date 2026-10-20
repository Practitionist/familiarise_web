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

/** floor(amount × numerator / denominator) in BigInt, so the product may exceed
 *  2^53; throws unless every input and the result are safe integers. */
export function prorate(
  amountPaise: number,
  numerator: number,
  denominator: number,
): number {
  if (denominator <= 0) {
    throw new Error(`prorate: non-positive denominator ${denominator}`);
  }
  for (const v of [amountPaise, numerator, denominator]) {
    if (!Number.isSafeInteger(v)) {
      throw new Error(`prorate: input ${v} is not a safe integer`);
    }
  }
  const product = BigInt(amountPaise) * BigInt(numerator);
  const den = BigInt(denominator);
  const q = product / den;
  return sumPaise(product % den < BigInt(0) ? q - BigInt(1) : q);
}
