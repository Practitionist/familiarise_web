/**
 * @jest-environment node
 */

/**
 * C1 — Canonical refund operation tests.
 *
 * Covers `refundPayment()` (app-initiated) and `applyRefundCascade()`
 * (gateway-cron-initiated) in `lib/payments/operations/refund.ts`.
 *
 * Strategy: stub the prisma client with a tiny in-memory state-machine
 * keyed off the test's seeded fixtures. We do NOT spin a real DB —
 * the cascade's logic (proportional split, last-leg-absorbs-remainder,
 * status flip thresholds, clawback gating) is pure math on top of the
 * model rows, and a faithful in-memory store is enough to exercise
 * every branch. Schema-level concerns (FK enforcement, Serializable
 * isolation) are validated separately by the integration suite.
 *
 * Each test seeds its own state (no cross-test leakage) by calling
 * `seed(state)` in `beforeEach`. The store mutates in place, so
 * assertions read straight off the same `state` object the cascade
 * modified.
 */

import type { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// In-memory prisma stub
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Store = {
  payments: Map<string, Row>;
  paymentLegs: Row[];
  refunds: Row[];
  consultantEarnings: Map<string, Row>;
  organizationEarnings: Map<string, Row>;
  organizationPayouts: Map<string, Row>;
  bookingUtilizations: Map<string, Row>; // keyed by paymentId
  usageLedgerEntries: Row[];
  programAssignments: Map<string, Row>;
  walletEntries: Row[];
  fundingLedgerEntries: Row[];
  billingAccounts: Map<string, Row>;
  organizationInvoices: Map<string, Row>;
  orgAuditLogs: Row[];
};

let state: Store;

function newStore(): Store {
  return {
    payments: new Map(),
    paymentLegs: [],
    refunds: [],
    consultantEarnings: new Map(),
    organizationEarnings: new Map(),
    organizationPayouts: new Map(),
    bookingUtilizations: new Map(),
    usageLedgerEntries: [],
    programAssignments: new Map(),
    walletEntries: [],
    fundingLedgerEntries: [],
    billingAccounts: new Map(),
    organizationInvoices: new Map(),
    orgAuditLogs: [],
  };
}

let uuidCounter = 0;
const stableUuid = (): string => `uuid-${++uuidCounter}`;

function txStub() {
  return {
    payment: {
      findUnique: jest.fn(async ({ where, select, include }: any) => {
        const p = state.payments.get(where.id);
        if (!p) return null;
        if (include) return hydratePayment(p);
        if (select) return projectSelect(hydratePayment(p), select);
        return p;
      }),
      findUniqueOrThrow: jest.fn(async ({ where, include }: any) => {
        const p = state.payments.get(where.id);
        if (!p) throw new Error(`Payment ${where.id} not found`);
        if (include) return hydratePayment(p);
        return p;
      }),
    },
    refund: {
      findMany: jest.fn(async ({ where, select }: any) => {
        const rows = state.refunds.filter((r) => {
          if (where.paymentId && r.paymentId !== where.paymentId) return false;
          if (where.status?.in && !where.status.in.includes(r.status)) return false;
          return true;
        });
        if (select) return rows.map((r) => projectSelect(r, select));
        return rows;
      }),
      create: jest.fn(async ({ data }: any) => {
        const created = {
          id: stableUuid(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.refunds.push(created);
        return created;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const r = state.refunds.find((x) => x.id === where.id);
        if (!r) throw new Error(`Refund ${where.id} not found`);
        Object.assign(r, data);
        return r;
      }),
    },
    paymentLeg: {
      create: jest.fn(async ({ data }: any) => {
        const created = { id: stableUuid(), createdAt: new Date(), ...data };
        state.paymentLegs.push(created);
        return created;
      }),
    },
    consultantEarnings: {
      update: jest.fn(async ({ where, data }: any) => {
        const e = state.consultantEarnings.get(where.id);
        if (!e) throw new Error(`ConsultantEarnings ${where.id} not found`);
        Object.assign(e, data);
        return e;
      }),
    },
    organizationEarnings: {
      update: jest.fn(async ({ where, data }: any) => {
        const e = state.organizationEarnings.get(where.id);
        if (!e) throw new Error(`OrganizationEarnings ${where.id} not found`);
        Object.assign(e, data);
        return e;
      }),
    },
    organizationPayout: {
      update: jest.fn(async ({ where, data }: any) => {
        const p = state.organizationPayouts.get(where.id);
        if (!p) throw new Error(`OrganizationPayout ${where.id} not found`);
        if (data.clawbackAmountPaise?.increment !== undefined) {
          p.clawbackAmountPaise =
            (p.clawbackAmountPaise as number) +
            data.clawbackAmountPaise.increment;
        }
        if (data.clawbackInitiatedAt !== undefined) {
          p.clawbackInitiatedAt = data.clawbackInitiatedAt;
        }
        return p;
      }),
    },
    organizationInvoice: {
      findUnique: jest.fn(async ({ where, select }: any) => {
        const inv = state.organizationInvoices.get(where.id);
        if (!inv) return null;
        if (select) return projectSelect(inv, select);
        return inv;
      }),
    },
    orgAuditLog: {
      create: jest.fn(async ({ data }: any) => {
        const created = { id: stableUuid(), createdAt: new Date(), ...data };
        state.orgAuditLogs.push(created);
        return created;
      }),
    },
    bookingUtilization: {
      findUnique: jest.fn(async ({ where, select }: any) => {
        const u = state.bookingUtilizations.get(where.paymentId);
        if (!u) return null;
        if (select) return projectSelect(u, select);
        return u;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const u = state.bookingUtilizations.get(where.paymentId);
        if (!u) throw new Error("util not found");
        Object.assign(u, data);
        return u;
      }),
    },
    programAssignment: {
      update: jest.fn(async ({ where, data }: any) => {
        const a = state.programAssignments.get(where.id);
        if (!a) throw new Error("assignment not found");
        if (data.engagementsUsed?.decrement !== undefined) {
          a.engagementsUsed =
            (a.engagementsUsed as number) - data.engagementsUsed.decrement;
        }
        if (data.overageCount?.decrement !== undefined) {
          a.overageCount =
            (a.overageCount as number) - data.overageCount.decrement;
        }
        return a;
      }),
    },
    usageLedgerEntry: {
      aggregate: jest.fn(async ({ where, _sum }: any) => {
        const rows = state.usageLedgerEntries.filter((r) => {
          if (where.paymentId && r.paymentId !== where.paymentId) return false;
          if (
            where.engagementsConsumed?.lt !== undefined &&
            !((r.engagementsConsumed as number) < where.engagementsConsumed.lt)
          )
            return false;
          return true;
        });
        const sum = rows.reduce(
          (acc, r) => acc + (r.engagementsConsumed as number),
          0,
        );
        return { _sum: { engagementsConsumed: sum } };
      }),
      create: jest.fn(async ({ data }: any) => {
        const created = { id: stableUuid(), createdAt: new Date(), ...data };
        state.usageLedgerEntries.push(created);
        return created;
      }),
    },
    walletEntry: {
      create: jest.fn(async ({ data }: any) => {
        const created = { id: stableUuid(), createdAt: new Date(), ...data };
        state.walletEntries.push(created);
        return created;
      }),
    },
    fundingLedgerEntry: {
      create: jest.fn(async ({ data }: any) => {
        const created = { id: stableUuid(), createdAt: new Date(), ...data };
        state.fundingLedgerEntries.push(created);
        return created;
      }),
    },
    billingAccount: {
      findUniqueOrThrow: jest.fn(async ({ where, select }: any) => {
        const a = state.billingAccounts.get(where.id);
        if (!a) throw new Error("billingAccount not found");
        if (select) return projectSelect(a, select);
        return a;
      }),
    },
    $executeRaw: jest.fn(async (..._parts: any[]) => {
      // walletCredit: increments BillingAccount.walletBalance.
      // We parse the template-literal to know which account by reading
      // the parameter list — Prisma passes interpolated values as
      // sequential args after the template-strings array. For our
      // tests we simply locate the BA by the only seeded id and bump
      // it; tests assert on the resulting balance.
      // The walletCredit helper passes (amountPaise, billingAccountId)
      // as the two interpolated values.
      const args = (_parts as any[]).slice(1);
      const amount = args[0] as number;
      const baId = args[1] as string;
      const acct = state.billingAccounts.get(baId);
      if (!acct) return 0;
      acct.walletBalance = ((acct.walletBalance as number) ?? 0) + amount;
      return 1;
    }),
  };
}

// Hydrate a payment with related rows for `include` queries.
function hydratePayment(p: Row): Row {
  return {
    ...p,
    legs: state.paymentLegs
      .filter((l) => l.paymentId === p.id)
      .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime()),
    earnings: Array.from(state.consultantEarnings.values()).filter(
      (e) => e.paymentId === p.id,
    ),
    organizationEarnings: Array.from(state.organizationEarnings.values())
      .filter((e) => e.paymentId === p.id)
      .map((e) => ({
        ...e,
        orgPayout: e.orgPayoutId
          ? state.organizationPayouts.get(e.orgPayoutId as string) ?? null
          : null,
      })),
    bookingUtilization: state.bookingUtilizations.get(p.id as string) ?? null,
    refunds: state.refunds.filter((r) => r.paymentId === p.id),
  };
}

function projectSelect(row: Row, select: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    out[k] = (row as Row)[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mock the prisma module — same client returned for both top-level + tx.
// ---------------------------------------------------------------------------

jest.mock("../../lib/prisma", () => {
  const stub = txStub();
  return {
    __esModule: true,
    default: {
      ...stub,
      $transaction: async (fn: any) => fn(stub),
    },
  };
});

// Audit-actions module is pure constants; no mock needed.

// ---------------------------------------------------------------------------
// Imports under test (after the prisma mock is registered).
// ---------------------------------------------------------------------------

import {
  refundPayment,
  applyRefundCascade,
  RefundValidationError,
} from "@/lib/payments/operations/refund";
import prisma from "@/lib/prisma";

const tx: any = prisma; // the stub IS the tx in our setup

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedSinglePartyWalletPayment({
  paymentId = "pay-1",
  amount = 10000,
  consultantSharePaise = 8000,
  orgShare = 1000,
  platformFeePaise = 1000,
  billingAccountId = "ba-1",
  organizationId = "org-1",
  walletBalance = 50000,
  withOrgEarnings = true,
  orgEarningsStatus = "PENDING" as const,
}: Partial<{
  paymentId: string;
  amount: number;
  consultantSharePaise: number;
  orgShare: number;
  platformFeePaise: number;
  billingAccountId: string;
  organizationId: string;
  walletBalance: number;
  withOrgEarnings: boolean;
  orgEarningsStatus: "PENDING" | "PAID";
}>) {
  state.payments.set(paymentId, {
    id: paymentId,
    amount,
    originalAmount: amount,
    currency: "INR",
    paymentStatus: "SUCCEEDED",
    paymentGateway: "RAZORPAY",
    displayCurrencyAtCheckout: null,
    exchangeRateAtCheckout: null,
    organizationId,
    billingAccountId,
    billableToOrgInvoiceId: null,
  });
  state.paymentLegs.push({
    id: "leg-w-1",
    paymentId,
    source: "WALLET",
    amountPaise: amount,
    sourceRef: "asg-1",
    createdAt: new Date(),
  });
  state.consultantEarnings.set("ce-1", {
    id: "ce-1",
    paymentId,
    consultantProfileId: "cp-1",
    consultantSharePaise,
    grossAmount: amount,
    platformFeePaise,
    refundedShareAmount: 0,
    status: "PENDING",
  });
  if (withOrgEarnings) {
    state.organizationEarnings.set("oe-1", {
      id: "oe-1",
      paymentId,
      organizationId,
      grossAmountPaise: amount,
      platformFeePaise: platformFeePaise,
      orgSharePaise: orgShare,
      consultantSharePaise: consultantSharePaise,
      refundedAmountPaise: 0,
      status: orgEarningsStatus,
      orgPayoutId: null,
    });
  }
  state.billingAccounts.set(billingAccountId, {
    id: billingAccountId,
    walletBalance,
    currency: "INR",
  });
}

beforeEach(() => {
  state = newStore();
  uuidCounter = 0;
  jest.clearAllMocks();
});

// ===========================================================================
// Tests
// ===========================================================================

describe("refundPayment — full single-leg WALLET refund", () => {
  it("reverses leg, credits wallet, marks ConsultantEarnings + OrganizationEarnings REFUNDED", async () => {
    seedSinglePartyWalletPayment({});

    const result = await refundPayment({
      paymentId: "pay-1",
      reason: "customer-request",
      initiatedByUserId: "user-admin",
    });

    expect(result.amountRefundedPaise).toBe(10000);
    expect(result.legsReversed).toBe(1);
    expect(result.consultantEarningsReversed).toBe(1);
    expect(result.organizationEarningsReversed).toBe(1);
    expect(result.clawbackInitiated).toBe(false);

    // Wallet credited.
    expect(state.billingAccounts.get("ba-1")?.walletBalance).toBe(60000);
    // ConsultantEarnings fully refunded.
    const ce = state.consultantEarnings.get("ce-1");
    expect(ce?.refundedShareAmount).toBe(8000);
    expect(ce?.status).toBe("REFUNDED");
    // OrganizationEarnings fully refunded.
    const oe = state.organizationEarnings.get("oe-1");
    expect(oe?.refundedAmountPaise).toBe(9000); // org + consultant share
    expect(oe?.status).toBe("REFUNDED");
    // Refund row flipped to SUCCEEDED.
    expect(state.refunds[0]?.status).toBe("SUCCEEDED");
  });
});

describe("refundPayment — partial 50% refund proportional split", () => {
  it("splits proportional, leaves earnings non-REFUNDED", async () => {
    seedSinglePartyWalletPayment({ amount: 10000, consultantSharePaise: 8000, orgShare: 1000 });

    const result = await refundPayment({
      paymentId: "pay-1",
      amountPaise: 5000, // 50%
      reason: "partial-refund",
    });

    expect(result.amountRefundedPaise).toBe(5000);
    expect(state.billingAccounts.get("ba-1")?.walletBalance).toBe(55000);

    const ce = state.consultantEarnings.get("ce-1");
    expect(ce?.refundedShareAmount).toBe(4000); // 50% of 8000
    expect(ce?.status).toBe("PENDING"); // not fully refunded

    const oe = state.organizationEarnings.get("oe-1");
    expect(oe?.refundedAmountPaise).toBe(4500); // 50% of (orgShare + consShare)
    expect(oe?.status).toBe("PENDING");
  });
});

describe("refundPayment — multi-leg WALLET + REFERRAL_CREDIT", () => {
  it("reverses each leg proportionally, last leg absorbs remainder", async () => {
    state.payments.set("pay-2", {
      id: "pay-2",
      amount: 10001, // odd amount forces a remainder
      originalAmount: 10001,
      currency: "INR",
      paymentStatus: "SUCCEEDED",
      paymentGateway: "RAZORPAY",
      displayCurrencyAtCheckout: null,
      exchangeRateAtCheckout: null,
      organizationId: null,
      billingAccountId: "ba-2",
      billableToOrgInvoiceId: null,
    });
    state.paymentLegs.push(
      {
        id: "leg-w-2",
        paymentId: "pay-2",
        source: "WALLET",
        amountPaise: 7001,
        sourceRef: "asg-2",
        createdAt: new Date(2026, 0, 1),
      },
      {
        id: "leg-rc-1",
        paymentId: "pay-2",
        source: "REFERRAL_CREDIT",
        amountPaise: 3000,
        sourceRef: "rcu-1",
        createdAt: new Date(2026, 0, 2),
      },
    );
    state.billingAccounts.set("ba-2", {
      id: "ba-2",
      walletBalance: 0,
      currency: "INR",
    });

    const result = await refundPayment({
      paymentId: "pay-2",
      reason: "full",
    });

    expect(result.amountRefundedPaise).toBe(10001);
    expect(result.legsReversed).toBe(2);
    // Wallet credited with the wallet leg's full original amount (last
    // leg absorbs remainder; in this case the WALLET leg appears first
    // chronologically but the cascade picks up the *last* positive leg
    // for the remainder, which is the REFERRAL_CREDIT leg. So the
    // wallet credit is exactly floor(7001 * 10001 / 10001) = 7001.
    expect(state.billingAccounts.get("ba-2")?.walletBalance).toBe(7001);
  });
});

describe("refundPayment — clawback when payout already COMPLETED", () => {
  it("increments OrganizationPayout.clawbackAmountPaise and stamps clawbackInitiatedAt", async () => {
    seedSinglePartyWalletPayment({ orgEarningsStatus: "PAID" });
    // Promote the org earnings: link to a COMPLETED payout.
    state.organizationPayouts.set("op-1", {
      id: "op-1",
      organizationId: "org-1",
      status: "COMPLETED",
      clawbackAmountPaise: 0,
      clawbackInitiatedAt: null,
    });
    const oe = state.organizationEarnings.get("oe-1")!;
    oe.orgPayoutId = "op-1";

    const before = Date.now();
    const result = await refundPayment({
      paymentId: "pay-1",
      reason: "post-payout-refund",
    });

    expect(result.clawbackInitiated).toBe(true);
    const op = state.organizationPayouts.get("op-1")!;
    expect(op.clawbackAmountPaise).toBe(1000); // = orgShare
    expect(op.clawbackInitiatedAt).toBeInstanceOf(Date);
    expect((op.clawbackInitiatedAt as Date).getTime()).toBeGreaterThanOrEqual(before);

    // PAYOUT_CLAWBACK audit row written.
    const audit = state.orgAuditLogs.find((l) => l.action === "PAYOUT_CLAWBACK");
    expect(audit).toBeDefined();
    expect((audit?.details as any)?.clawbackAmountPaise).toBe(1000);
  });

  it("preserves earliest clawbackInitiatedAt across multiple partial refunds", async () => {
    seedSinglePartyWalletPayment({ orgEarningsStatus: "PAID" });
    const firstStamp = new Date(2026, 0, 1);
    state.organizationPayouts.set("op-1", {
      id: "op-1",
      organizationId: "org-1",
      status: "COMPLETED",
      clawbackAmountPaise: 200,
      clawbackInitiatedAt: firstStamp,
    });
    state.organizationEarnings.get("oe-1")!.orgPayoutId = "op-1";

    await refundPayment({ paymentId: "pay-1", amountPaise: 5000, reason: "second-clawback" });

    const op = state.organizationPayouts.get("op-1")!;
    expect(op.clawbackAmountPaise).toBe(200 + 500); // 50% of orgShare
    expect(op.clawbackInitiatedAt).toBe(firstStamp); // not overwritten
  });
});

describe("refundPayment — validation guards", () => {
  it("rejects refund > refundable", async () => {
    seedSinglePartyWalletPayment({ amount: 10000 });
    await expect(
      refundPayment({ paymentId: "pay-1", amountPaise: 99999, reason: "x" }),
    ).rejects.toBeInstanceOf(RefundValidationError);
  });

  it("rejects refund on non-SUCCEEDED payment", async () => {
    seedSinglePartyWalletPayment({});
    state.payments.get("pay-1")!.paymentStatus = "PENDING";
    await expect(
      refundPayment({ paymentId: "pay-1", reason: "x" }),
    ).rejects.toBeInstanceOf(RefundValidationError);
  });

  it("rejects refund on missing payment", async () => {
    await expect(
      refundPayment({ paymentId: "missing", reason: "x" }),
    ).rejects.toBeInstanceOf(RefundValidationError);
  });

  it("rejects refund on already-fully-refunded payment", async () => {
    seedSinglePartyWalletPayment({ amount: 10000 });
    state.refunds.push({
      id: "r-existing",
      paymentId: "pay-1",
      amount: 10000,
      status: "SUCCEEDED",
    });
    await expect(
      refundPayment({ paymentId: "pay-1", reason: "x" }),
    ).rejects.toBeInstanceOf(RefundValidationError);
  });
});

describe("applyRefundCascade — gateway-cron entry path", () => {
  it("runs cascade against an existing Refund row without creating one", async () => {
    seedSinglePartyWalletPayment({});
    // Seed an existing Refund (gateway-created via webhook).
    state.refunds.push({
      id: "r-gateway",
      paymentId: "pay-1",
      amount: 10000,
      status: "SUCCEEDED",
      refundId: "rfnd_xyz",
    });

    const refundsBefore = state.refunds.length;
    const result = await applyRefundCascade(tx, {
      paymentId: "pay-1",
      refundId: "r-gateway",
      amountPaise: 10000,
      reason: "gateway-refund",
    });

    expect(state.refunds).toHaveLength(refundsBefore); // no new Refund row
    expect(result.consultantEarningsReversed).toBe(1);
    expect(result.organizationEarningsReversed).toBe(1);
    expect(state.consultantEarnings.get("ce-1")?.status).toBe("REFUNDED");
  });
});
