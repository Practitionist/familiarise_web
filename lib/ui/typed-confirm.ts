/**
 * Q10 (#1527): refunds and payout approvals at or above ₹10,000 ask the
 * operator to type a confirmation word, on top of the reason every money
 * action already asks for. One constant so the threshold moves in one place.
 */
export const TYPED_CONFIRM_THRESHOLD_PAISE = 1_000_000;

export function needsTypedConfirm(amountPaise: number | bigint): boolean {
  return typeof amountPaise === "bigint"
    ? amountPaise >= BigInt(TYPED_CONFIRM_THRESHOLD_PAISE)
    : amountPaise >= TYPED_CONFIRM_THRESHOLD_PAISE;
}
