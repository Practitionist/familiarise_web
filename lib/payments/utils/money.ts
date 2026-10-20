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

/** amount × numerator / denominator rounded exactly in BigInt, so the product may exceed
 *  2^53; "round" is half toward +∞ like Math.round (−2.5 → −2). Throws unless every
 *  input and the result are safe integers. */
export function prorate(
  amountPaise: number,
  numerator: number,
  denominator: number,
  mode: "floor" | "round" | "ceil" = "floor",
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
  if (mode === "ceil") return floorDiv(product + den - BigInt(1), den);
  if (mode === "round") {
    return floorDiv(BigInt(2) * product + den, BigInt(2) * den);
  }
  return floorDiv(product, den);
}

function floorDiv(n: bigint, d: bigint): number {
  const q = n / d;
  return sumPaise(n % d < BigInt(0) ? q - BigInt(1) : q);
}
