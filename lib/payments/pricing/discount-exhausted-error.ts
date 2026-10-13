/** A discount code already at its `maxUses`; registered as a 409 business refusal. */
export class DiscountExhaustedError extends Error {
  readonly code = "DISCOUNT_EXHAUSTED" as const;
  readonly httpStatus = 409;

  constructor(
    readonly currentUses: number,
    readonly maxUses: number,
  ) {
    super(
      `Discount code has reached maximum uses (${currentUses}/${maxUses}) — please remove the code and try again.`,
    );
    this.name = "DiscountExhaustedError";
  }
}
