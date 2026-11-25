/**
 * @jest-environment node
 */

// Invariant: a batch never claims an earning while money is owed back on its
// payment (a refund in flight, an active dispute, an owed-refund marker). The
// earning stays READY for a later batch, and the amount shown as available
// leaves it out.

import {
  matchesWhere,
  type memTable,
  type Row,
  type Where,
} from "../fixtures/mem-db";

const CP = "cp_1";
const ORG = "org_1";
const CREATED = new Date("2026-11-01T00:00:00.000Z");

jest.mock("../../lib/prisma", () => {
  const mem = jest.requireActual("../fixtures/mem-db");
  const sum = (rows: Row[], key: string) =>
    rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);
  const consultantRows: Row[] = [];
  const hits = (where: Where) =>
    consultantRows.filter((r) => mem.matchesWhere(r, where));
  const consultantEarnings = {
    ...mem.memTable(consultantRows, "ce"),
    groupBy: jest.fn(async ({ where }: { where: Where }) =>
      hits(where).length
        ? [
            {
              consultantProfileId: "cp_1",
              _sum: {
                consultantSharePaise: sum(hits(where), "consultantSharePaise"),
              },
            },
          ]
        : [],
    ),
    aggregate: jest.fn(async ({ where }: { where: Where }) => ({
      _sum: {
        consultantSharePaise: sum(hits(where), "consultantSharePaise"),
        refundedShareAmount: sum(hits(where), "refundedShareAmount"),
      },
    })),
  };
  const client = {
    consultantEarnings,
    organizationEarnings: mem.memTable([], "oe"),
    consultantPayout: {
      create: jest.fn(async ({ data }: { data: Row }) => ({
        id: "po_1",
        ...data,
      })),
    },
    organizationPayout: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: Row }) => ({
        id: "op_1",
        ...data,
      })),
      update: jest.fn(async () => ({})),
    },
    payoutAccount: {
      findFirst: jest.fn(async () => ({
        id: "pa_1",
        provider: "RAZORPAY",
        accountType: "BANK_ACCOUNT",
        isVerified: true,
      })),
    },
    organizationPayoutAccount: {
      findUnique: jest.fn(async () => ({ id: "opa_1", status: "VERIFIED" })),
    },
    consultantProfile: { findUnique: jest.fn(async () => null) },
    consultantTaxInfo: { findUnique: jest.fn(async () => null) },
    organization: { findUnique: jest.fn(async () => null) },
    orgAuditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(
      async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(client),
    ),
  };
  return { __esModule: true, default: client };
});
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn(async () => "tok"),
  releaseLock: jest.fn(async () => undefined),
  isMockRedis: jest.fn(() => false),
  checkRedisHealth: jest.fn(async () => true),
  isRedisCircuitOpen: jest.fn(() => false),
}));
jest.mock("../../lib/compliance/tds", () => ({
  ...jest.requireActual("../../lib/compliance/tds"),
  resolveEffectiveTdsRate: jest.fn(async () => 0.001),
}));
jest.mock("../../lib/payments/payouts/clawback-recovery", () => ({
  ...jest.requireActual("../../lib/payments/payouts/clawback-recovery"),
  outstandingClawbackPaise: jest.fn(async () => 0),
  recoverClawbackOnPayout: jest.fn(async () => 0),
}));

import {
  checkPayoutEligibility,
  createPayoutBatch,
} from "@/lib/payments/payouts/payout-service";
import { createOrgPayoutBatch } from "@/lib/payments/payouts/org-payout-service";
import {
  DISPUTE_GATED_PAYMENT_WHERE,
  REFUND_GATED_PAYMENT_WHERE,
} from "@/lib/payments/payouts/shared-lifecycle";
import prisma from "@/lib/prisma";
import {
  MONEY_OWED_PAYMENT,
  NO_MONEY_OWED_PAYMENT,
} from "@/scripts/earnings/release-earnings";

type Table = ReturnType<typeof memTable>;
const consultantRows = (prisma.consultantEarnings as unknown as Table).rows;
const orgRows = (prisma.organizationEarnings as unknown as Table).rows;
const consultantPayoutCreate = prisma.consultantPayout.create as jest.Mock;
const orgPayoutUpdate = prisma.organizationPayout.update as jest.Mock;

const clean = { refundOwedKey: null, refunds: [], disputes: [] };
const payments: Record<string, Row> = {
  ok: { id: "pay_ok", ...clean },
  marker: { id: "pay_marker", ...clean, refundOwedKey: "cancel:appt_1" },
  dispute: {
    id: "pay_dispute",
    ...clean,
    disputes: [{ status: "NEEDS_RESPONSE" }],
  },
  refund: {
    id: "pay_refund",
    ...clean,
    refunds: [{ amountPaise: 5_000, status: "SUCCEEDED", cascadedAt: null }],
  },
};

const GATED = ["marker", "dispute", "refund"] as const;

beforeEach(() => {
  jest.clearAllMocks();
  consultantRows.splice(
    0,
    consultantRows.length,
    ...Object.entries(payments).map(([key, payment]) => ({
      id: `ce_${key}`,
      consultantProfileId: CP,
      status: "READY",
      payoutId: null,
      consultantSharePaise: 40_000,
      refundedShareAmount: 0,
      payment,
    })),
  );
  orgRows.splice(
    0,
    orgRows.length,
    ...Object.entries(payments).map(([key, payment]) => ({
      id: `oe_${key}`,
      organizationId: ORG,
      status: "READY",
      orgPayoutId: null,
      createdAt: CREATED,
      grossAmountPaise: 100_000,
      platformFeePaise: 10_000,
      orgSharePaise: 40_000,
      refundedAmountPaise: 0,
      currency: "INR",
      payment,
    })),
  );
});

it("the consultant batch pays the clean earning and leaves each money-owed one READY", async () => {
  const run = await createPayoutBatch();

  expect(run).toMatchObject({ minted: 1, failed: 0 });
  expect(consultantPayoutCreate.mock.calls[0][0].data.amount).toBe(40_000);
  const byId = Object.fromEntries(consultantRows.map((r) => [r.id, r]));
  expect(byId.ce_ok).toMatchObject({ status: "BATCHED", payoutId: "po_1" });
  for (const key of GATED) {
    expect(byId[`ce_${key}`]).toMatchObject({
      status: "READY",
      payoutId: null,
    });
  }
});

it("the amount shown as available leaves the money-owed earnings out", async () => {
  const eligibility = await checkPayoutEligibility(CP);
  expect(eligibility.readyAmount).toBe(40_000);
});

it("the organisation batch pays the clean earning and leaves each money-owed one READY", async () => {
  const out = await createOrgPayoutBatch(
    ORG,
    new Date(CREATED.getTime() - 1_000),
    new Date(CREATED.getTime() + 1_000),
  );

  expect(out.earningsCount).toBe(1);
  expect(orgPayoutUpdate.mock.calls[0][0].data.netPayoutPaise).toBe(40_000);
  const byId = Object.fromEntries(orgRows.map((r) => [r.id, r]));
  expect(byId.oe_ok).toMatchObject({ status: "BATCHED", orgPayoutId: "op_1" });
  for (const key of GATED) {
    expect(byId[`oe_${key}`]).toMatchObject({
      status: "READY",
      orgPayoutId: null,
    });
  }
});

it("the batching form and the claim-gate forms are one set of clauses", () => {
  const cases: Row[] = [
    ...Object.values(payments),
    { ...clean, refunds: [{ amountPaise: 5_000, status: "PENDING" }] },
    { ...clean, refunds: [{ amountPaise: 5_000, status: "FAILED" }] },
    { ...clean, disputes: [{ status: "WON" }] },
  ];
  for (const payment of cases) {
    const owed = Object.values(MONEY_OWED_PAYMENT).some((clause) =>
      matchesWhere(payment, clause),
    );
    expect(matchesWhere(payment, NO_MONEY_OWED_PAYMENT)).toBe(!owed);
    expect(
      matchesWhere(payment, DISPUTE_GATED_PAYMENT_WHERE) ||
        matchesWhere(payment, REFUND_GATED_PAYMENT_WHERE),
    ).toBe(owed);
  }
});
