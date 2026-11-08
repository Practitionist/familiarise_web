/**
 * @jest-environment node
 */

// Invariant: a payment sold while unregistered never gets a tax invoice, and the daily
// turnover alarm reports once at ₹15 lakh of financial-year turnover.

const mockReport = jest.fn();
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: (...a: unknown[]) => mockReport(...a),
}));
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  CONSUMER_INVOICEABLE_PAYMENT_WHERE,
  mintConsumerInvoice,
} from "@/lib/payments/billing/consumer-invoice";
import { checkGstRegistrationTurnover } from "@/lib/compliance/gst-turnover";
import type { Db, Tx } from "@/lib/prisma";

it("never mints, and never cohorts, a payment stamped UNREGISTERED", async () => {
  const allocate = jest.fn();
  const tx = {
    consumerInvoice: { findUnique: async () => null, create: allocate },
    consumerInvoiceCounter: { upsert: allocate },
    payment: {
      findUnique: async () => ({
        id: "pay_1",
        amount: 100_000,
        taxAmount: 0,
        currency: "INR",
        paymentStatus: "SUCCEEDED",
        deletedAt: null,
        buyerCountry: "IN",
        gstRegime: "UNREGISTERED",
        consumerStateCode: "06",
        billableToOrgInvoiceId: null,
        createdAt: new Date("2026-11-09T10:00:00Z"),
        userId: "user_1",
        legs: [{ source: "CARD" }],
        creditUsages: [],
        digitalProductPurchase: null,
        refunds: [],
        user: {
          id: "user_1",
          name: "Priya",
          email: "priya@example.com",
          address: null,
          city: null,
          consulteeProfile: { billingStateCode: "06" },
        },
      }),
    },
  } as unknown as Tx;

  await expect(
    mintConsumerInvoice(tx, { paymentId: "pay_1" }),
  ).resolves.toEqual({ consumerInvoiceId: null });
  expect(allocate).not.toHaveBeenCalled();
  expect(CONSUMER_INVOICEABLE_PAYMENT_WHERE.AND).toEqual([
    { OR: [{ gstRegime: null }, { gstRegime: "REGISTERED" }] },
  ]);
});

/** Aggregates for one financial year: charged cash, credit still spent, cash refunded. */
function turnoverDb(sums: {
  charged: number;
  credits: number;
  refunded: number;
}) {
  const wheres: unknown[] = [];
  const db = {
    payment: {
      aggregate: async (args: { where: unknown }) => {
        wheres.push(args.where);
        return { _sum: { amount: sums.charged, taxAmount: 0 } };
      },
    },
    referralCreditUsage: {
      aggregate: async () => ({ _sum: { amount: sums.credits } }),
    },
    refund: {
      aggregate: async () => ({ _sum: { amountPaise: sums.refunded } }),
    },
  } as unknown as Db;
  return { db, wheres };
}

const now = new Date("2027-01-10T04:00:00Z");

it("reports turnover once it reaches ₹15 lakh, net of refunds, plus credits", async () => {
  const quiet = turnoverDb({
    charged: 100_000_000,
    credits: 6_000_000,
    refunded: 8_000_000,
  });
  await expect(
    checkGstRegistrationTurnover(quiet.db, now),
  ).resolves.toMatchObject({ turnoverPaise: 98_000_000, alarmed: false });
  expect(mockReport).not.toHaveBeenCalled();
  // Sold in the year by capture time, or by creation for rails confirmed at checkout.
  expect(quiet.wheres[0]).toMatchObject({
    OR: [
      { capturedAt: { gte: new Date("2026-03-31T18:30:00Z") } },
      {
        capturedAt: null,
        createdAt: { gte: new Date("2026-03-31T18:30:00Z") },
      },
    ],
  });

  const loud = await checkGstRegistrationTurnover(
    turnoverDb({
      charged: 154_000_000,
      credits: 6_000_000,
      refunded: 8_000_000,
    }).db,
    now,
  );
  expect(loud).toMatchObject({
    turnoverPaise: 152_000_000,
    alarmed: true,
    financialYearStart: new Date("2026-03-31T18:30:00Z"),
  });
  expect(mockReport).toHaveBeenCalledTimes(1);
  expect(String(mockReport.mock.calls[0][0])).toMatch(/₹20,00,000/);
});

it("counts a fully refunded ₹900 cash + ₹100 credit sale as zero", async () => {
  // The refund returns the ₹900 cash; reverseCreditsForPayment deletes the ₹100 usage row.
  const { db } = turnoverDb({ charged: 90_000, credits: 0, refunded: 90_000 });
  await expect(checkGstRegistrationTurnover(db, now)).resolves.toMatchObject({
    turnoverPaise: 0,
  });
});
