/**
 * @jest-environment node
 */
import { isZeroAmountOrder } from "@/lib/payments/checkout/zero-amount";

describe("an order with nothing left to charge never reaches the gateway", () => {
  it("takes the no-gateway rail when a full discount zeroes the total without credits", () => {
    expect(isZeroAmountOrder(0, false)).toBe(true);
  });

  it("charges any positive total through the gateway", () => {
    expect(isZeroAmountOrder(100, false)).toBe(false);
  });

  it("leaves org-sponsored orders on their own rail", () => {
    expect(isZeroAmountOrder(0, true)).toBe(false);
  });
});
