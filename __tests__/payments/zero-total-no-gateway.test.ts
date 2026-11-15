/**
 * @jest-environment node
 */
import {
  hasBilledSupply,
  isZeroAmountOrder,
} from "@/lib/payments/checkout/zero-amount";

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

describe("a free order with no credit has no supply to invoice", () => {
  it("bills nothing when neither money nor credit funded the order", () => {
    expect(hasBilledSupply(0, 0)).toBe(false);
  });

  it("still bills a ₹0 order that credits funded, and any charged order", () => {
    expect(hasBilledSupply(0, 50_000)).toBe(true);
    expect(hasBilledSupply(100, 0)).toBe(true);
  });
});
