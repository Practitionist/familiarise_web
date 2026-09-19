/**
 * @jest-environment node
 */

/**
 * #1757 — the seed re-runs at every reset, so anything it mints comes back.
 * Every finding the 2026-09-19 scan chased (a PENDING payment nothing could
 * retire, a PROCESSING payout with a fake gateway id, a PENDING refund on a
 * fenced gateway, a dispute already past due) was a seed-shaped row. These
 * pins hold the seed's row builders to the same invariants production writes
 * hold to, without a database.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));
// faker ships ESM only; the builders under test need one integer draw, which
// is pinned to the range's floor so the deadline assertion is deterministic.
jest.mock("@faker-js/faker", () => ({
  faker: {
    number: {
      int: ({ min }: { min: number; max: number }) => min,
      float: ({ min }: { min: number; max: number }) => min,
    },
    helpers: { arrayElement: <T>(items: T[]) => items[0] },
    string: { alphanumeric: () => "x", uuid: () => "uuid" },
    date: { recent: () => new Date(0), soon: () => new Date(0) },
    datatype: { boolean: () => false },
  },
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: jest.fn(),
}));

import {
  SEED_PAYMENT_STATUS_WEIGHTS,
  buildSeedPaymentLegs,
} from "../../prisma/seedFiles/8b-create-payments";
import { seedRefundStatus } from "../../prisma/seedFiles/12a-create-refunds";
import { seedDisputeDueBy } from "../../prisma/seedFiles/12b-create-disputes";
import {
  SEED_PAYOUT_STATUS_WEIGHTS,
  buildSeedPayoutPostings,
  seedEarningStatusForPayout,
} from "../../prisma/seedFiles/13c-create-payouts";

const DAY = 24 * 60 * 60 * 1000;

describe("seeded payments", () => {
  it("never mint a PENDING row (nothing could ever retire it)", () => {
    expect(SEED_PAYMENT_STATUS_WEIGHTS.map((w) => w.value)).not.toContain(
      "PENDING",
    );
  });

  it("give a SUCCEEDED row one CARD leg equal to its amount, and nothing else a leg", () => {
    expect(buildSeedPaymentLegs("SUCCEEDED", 118_000)).toEqual([
      { source: "CARD", amountPaise: 118_000 },
    ]);
    expect(buildSeedPaymentLegs("FAILED", 118_000)).toEqual([]);
    expect(buildSeedPaymentLegs("EXPIRED", 118_000)).toEqual([]);
    expect(buildSeedPaymentLegs("SUCCEEDED", 0)).toEqual([]);
  });
});

describe("seeded refunds and disputes", () => {
  it("refunds are SUCCEEDED on every gateway (no PENDING on a fenced one)", () => {
    for (const gateway of [
      "STRIPE",
      "RAZORPAY",
      "CARD",
      "DODO_PAYMENTS",
    ] as const) {
      expect(seedRefundStatus(gateway)).toBe("SUCCEEDED");
    }
  });

  it("an open dispute is due 30–90 days out; a terminal one carries no deadline", () => {
    const now = new Date("2026-09-20T00:00:00Z");
    for (const status of [
      "NEEDS_RESPONSE",
      "WARNING_NEEDS_RESPONSE",
    ] as const) {
      const dueBy = seedDisputeDueBy(status, now);
      expect(dueBy).not.toBeNull();
      expect(dueBy!.getTime()).toBeGreaterThanOrEqual(now.getTime() + 30 * DAY);
      expect(dueBy!.getTime()).toBeLessThanOrEqual(now.getTime() + 90 * DAY);
    }
    for (const status of [
      "WON",
      "LOST",
      "UNDER_REVIEW",
      "CHARGE_REFUNDED",
    ] as const) {
      expect(seedDisputeDueBy(status, now)).toBeNull();
    }
  });
});

describe("seeded payouts", () => {
  it("only take statuses the reconcilers accept without a gateway", () => {
    const statuses = SEED_PAYOUT_STATUS_WEIGHTS.map((w) => w.value);
    expect(statuses).not.toContain("PROCESSING");
    expect(statuses).not.toContain("FAILED");
    expect(statuses).toEqual(
      expect.arrayContaining(["PENDING", "APPROVED", "COMPLETED"]),
    );
  });

  it("a COMPLETED payout's journal balances: Dr CONSULTANT_PAYABLE == Cr CASH", () => {
    const postings = buildSeedPayoutPostings({
      consultantProfileId: "cprof_1",
      amountPaise: 250_000,
    });
    const debits = postings
      .filter((p) => p.direction === "DEBIT")
      .reduce((s, p) => s + p.amountPaise, 0);
    const credits = postings
      .filter((p) => p.direction === "CREDIT")
      .reduce((s, p) => s + p.amountPaise, 0);
    expect(debits).toBe(250_000);
    expect(credits).toBe(250_000);
    expect(postings.map((p) => p.account.kind).sort()).toEqual([
      "CASH",
      "CONSULTANT_PAYABLE",
    ]);
  });

  it("earnings are PAID only behind a COMPLETED payout, BATCHED otherwise", () => {
    expect(seedEarningStatusForPayout("COMPLETED")).toBe("PAID");
    expect(seedEarningStatusForPayout("APPROVED")).toBe("BATCHED");
    expect(seedEarningStatusForPayout("PENDING")).toBe("BATCHED");
  });
});
