/**
 * The money arithmetic behind the Money overview page.
 *
 * These are the functions that decide what "net revenue" and "take rate"
 * mean, so they are pinned: a change in any of them changes a number the
 * platform operator reads, and it has to be a deliberate change.
 */

import {
  discountGivenPaise,
  isMoneyDrillKey,
  moneyOverviewPeriods,
  netRevenuePaise,
  platformFeePaise,
  refundedFeePaise,
} from "@/lib/backoffice/money-overview";
import {
  isMoneyOverviewDays,
  MONEY_OVERVIEW_PERIODS,
} from "@/schemas/money-overview";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

// The needs-human read drags the refund/email stack in behind it; this suite
// only exercises the pure arithmetic, so it is stubbed out.
jest.mock("../../lib/backoffice/needs-human", () => ({
  readRefundNeedsHuman: jest.fn(async () => []),
}));

const LIST_PRICE = 100_000; // ₹1,000
const TAX = 16_200; // 18% of the discounted base
const CHARGED = LIST_PRICE + TAX; // ₹1,162

describe("the platform's take on one sale", () => {
  it("takes the stamped rate on the gross price", () => {
    expect(
      platformFeePaise({
        amount: CHARGED,
        originalAmount: LIST_PRICE,
        taxAmount: TAX,
        platformFeeBps: 2000,
      }),
    ).toBe(20_000);
  });

  it("takes nothing when the sale carries no stamped rate", () => {
    expect(
      platformFeePaise({
        amount: CHARGED,
        originalAmount: LIST_PRICE,
        taxAmount: TAX,
        platformFeeBps: null,
      }),
    ).toBe(0);
  });

  it("reads the discount as the gap between the gross price and the charge", () => {
    expect(
      discountGivenPaise({
        amount: CHARGED - 10_000,
        originalAmount: LIST_PRICE,
        taxAmount: TAX,
        platformFeeBps: 2000,
      }),
    ).toBe(10_000);
  });

  it("gives the fee back pro-rata when the sale is refunded", () => {
    const row = {
      amount: CHARGED,
      originalAmount: LIST_PRICE,
      taxAmount: TAX,
      platformFeeBps: 2000,
    };
    expect(refundedFeePaise(row, 50_000)).toBe(10_000);
    expect(netRevenuePaise(row, 50_000)).toBe(10_000);
  });

  it("keeps the fee less the discount it funded", () => {
    expect(
      netRevenuePaise({
        amount: CHARGED - 10_000,
        originalAmount: LIST_PRICE,
        taxAmount: TAX,
        platformFeeBps: 2000,
      }),
    ).toBe(10_000);
  });
});

describe("the comparison windows", () => {
  const now = new Date("2026-10-20T09:30:00.000Z");

  it("aligns the current window to day boundaries and the prior one to it", () => {
    const periods = moneyOverviewPeriods(30, now);
    expect(periods.current.start.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(periods.current.end.toISOString()).toBe("2026-10-21T00:00:00.000Z");
    expect(periods.prior.start.toISOString()).toBe("2026-08-22T00:00:00.000Z");
    expect(periods.prior.end.toISOString()).toBe(
      periods.current.start.toISOString(),
    );
  });

  it("gives the two windows the same length", () => {
    const periods = moneyOverviewPeriods(7, now);
    const currentDays =
      (periods.current.end.getTime() - periods.current.start.getTime()) /
      86_400_000;
    const priorDays =
      (periods.prior.end.getTime() - periods.prior.start.getTime()) / 86_400_000;
    expect(currentDays).toBe(priorDays);
    expect(currentDays).toBe(7);
  });
});

describe("the query boundaries", () => {
  it("accepts only the windows the page offers", () => {
    for (const period of MONEY_OVERVIEW_PERIODS) {
      expect(isMoneyOverviewDays(period)).toBe(true);
    }
    expect(isMoneyOverviewDays(14)).toBe(false);
    expect(isMoneyOverviewDays("30")).toBe(false);
  });

  it("accepts only the drill-throughs that exist", () => {
    expect(isMoneyDrillKey("gmv")).toBe(true);
    expect(isMoneyDrillKey("refund-reason")).toBe(true);
    expect(isMoneyDrillKey("nope")).toBe(false);
  });
});
