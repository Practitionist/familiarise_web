/**
 * @jest-environment node
 */

/**
 * Home's "Spent personally" counts by payer: a member's own card payment
 * counts even when checkout tagged it with their organization, and a payment
 * an organization's rail covered never does.
 */

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findMany: jest.fn() },
    referralCredit: { aggregate: jest.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { readConsulteeMoneySummary } from "@/lib/data/consultee-payments";

const m = prisma as unknown as {
  payment: { findMany: jest.Mock };
  referralCredit: { aggregate: jest.Mock };
};

type Row = {
  amount: number;
  currency: string;
  paymentMethod: string;
  organizationId: string | null;
  refunds: { amountPaise: number; status: string }[];
};

const ROWS: Row[] = [
  // The member's own card, tagged with their organization at checkout.
  {
    amount: 150_000,
    currency: "INR",
    paymentMethod: "CARD",
    organizationId: "org-1",
    refunds: [],
  },
  // An untagged personal card payment, half refunded.
  {
    amount: 50_000,
    currency: "INR",
    paymentMethod: "CARD",
    organizationId: null,
    refunds: [{ amountPaise: 25_000, status: "SUCCEEDED" }],
  },
  // Organization money on each rail: never personal spend.
  ...["WALLET", "INVOICE", "LICENSE"].map((paymentMethod) => ({
    amount: 99_000,
    currency: "INR",
    paymentMethod,
    organizationId: "org-1",
    refunds: [],
  })),
];

type FundingWhere = {
  organizationId?: string | null;
  paymentMethod?: { notIn?: string[] };
};

/** Applies the two funding filters a WHERE may carry to the fixture rows. */
function applyFunding(where: FundingWhere): Row[] {
  return ROWS.filter(
    (r) =>
      (!("organizationId" in where) ||
        r.organizationId === where.organizationId) &&
      !(where.paymentMethod?.notIn ?? []).includes(r.paymentMethod),
  );
}

beforeEach(() => {
  m.payment.findMany.mockImplementation(({ where }) =>
    Promise.resolve(applyFunding(where as FundingWhere)),
  );
  m.referralCredit.aggregate.mockResolvedValue({
    _sum: { remainingAmount: 0 },
  });
});

describe("readConsulteeMoneySummary", () => {
  it("counts personal-rail payments whatever their organization tag", async () => {
    const summary = await readConsulteeMoneySummary({
      consulteeId: "ce-1",
      userId: "u-1",
      now: new Date("2026-11-10T04:00:00.000Z"),
    });
    expect(summary.spentThisMonth).toEqual([
      { currency: "INR", paise: 150_000 + 50_000 - 25_000 },
    ]);
  });

  it("keeps the settled-money filter", async () => {
    await readConsulteeMoneySummary({ consulteeId: "ce-1", userId: "u-1" });
    expect(m.payment.findMany.mock.calls[0][0].where).toMatchObject({
      userId: "u-1",
      paymentStatus: "SUCCEEDED",
      parentPaymentId: null,
      deletedAt: null,
    });
  });
});
