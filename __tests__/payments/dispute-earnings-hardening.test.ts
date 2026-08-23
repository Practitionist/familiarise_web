/**
 * @jest-environment node
 */

/**
 * #1020 findings 1–3 — dispute → earnings hardening in handleDisputeCreated /
 * handleDisputeUpdated (app/api/webhooks/utils.ts).
 *
 * 1. preDisputeStatus — a dispute HELD a PENDING earning and a WON release
 *    force-matured it to READY. The hold now records the prior status and the
 *    release restores it; a second dispute can't clobber a first hold's
 *    marker because the hold CAS excludes already-HELD rows.
 * 2. Paid-earning clawback — the LOST loops queried status:HELD only, missing
 *    earnings already paid out before the chargeback landed. Both loops now
 *    include PAID rows; the consultant rail has no auto-clawback, so it flips
 *    state truthfully and pages ops once per dispute with the total.
 * 3. Proration — a PARTIAL dispute used to reverse the FULL share on both
 *    sides; reversals are now floored to `share × dispute/payment`.
 */

const recordSystemError = jest.fn().mockResolvedValue(undefined);
const razorpayPaymentsFetch = jest.fn();
const applyReversal = jest.fn().mockResolvedValue({});
const recordTdsReversal = jest.fn().mockResolvedValue(undefined);

jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemError: (...args: unknown[]) => recordSystemError(...args),
  recordSystemEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  __esModule: true,
  razorpayClient: {
    payments: { fetch: (...a: unknown[]) => razorpayPaymentsFetch(...a) },
  },
}));
jest.mock("../../lib/payments/core/stripe", () => ({ stripeClient: null }));
jest.mock("../../lib/novu", () => ({
  notifyRefundProcessed: jest.fn(),
  notifyDisputeCreated: jest.fn(),
  notifyDisputeResolved: jest.fn(),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgInvoicePaid: jest.fn(),
  notifyOrgWalletTopupConfirmed: jest.fn(),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyRefundFailed: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn().mockResolvedValue(0),
}));
jest.mock("../../lib/api/organizations/wallet", () => ({
  confirmTopUp: jest.fn(),
  walletCredit: jest.fn(),
  walletDebit: jest.fn(),
  WalletInsufficientFundsError: class extends Error {},
}));
jest.mock("../../lib/payments/payouts", () => ({
  handlePayoutWebhook: jest.fn(),
  markOrgPayoutCompleted: jest.fn(),
  markOrgPayoutFailed: jest.fn(),
  markOrgPayoutReversed: jest.fn(),
  markConsultantPayoutReversed: jest.fn(),
}));
jest.mock("../../lib/payments/webhooks/handlers", () => ({
  handlePaymentSuccess: jest.fn(),
  handlePaymentFailure: jest.fn(),
}));
jest.mock("../../lib/payments/operations/reversal-engine", () => ({
  applyReversal: (...a: unknown[]) => applyReversal(...a),
}));
jest.mock("../../lib/payments/tax/tds-service", () => ({
  recordTdsReversal: (...a: unknown[]) => recordTdsReversal(...a),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  applyRefundCascade: jest.fn().mockResolvedValue({}),
  mintInvoiceRefundCreditNote: jest.fn(),
  mintRefundCreditNote: jest.fn().mockResolvedValue({ creditNoteId: null }),
}));

type Row = Record<string, unknown>;

const store: {
  payments: Map<string, Row>;
  disputes: Row[];
  consultantEarnings: Row[];
  orgEarnings: Row[];
} = {
  payments: new Map(),
  disputes: [],
  consultantEarnings: [],
  orgEarnings: [],
};

function resetStore() {
  store.payments.clear();
  store.disputes.length = 0;
  store.consultantEarnings.length = 0;
  store.orgEarnings.length = 0;
}

/** In-memory tables for exactly the queries handleDispute* issues. */
function txStub() {
  return {
    payment: {
      findUnique: jest.fn(async ({ where }: { where: Row }) => {
        if (where.paymentIntent) {
          return (
            Array.from(store.payments.values()).find(
              (p) => p.paymentIntent === where.paymentIntent,
            ) ?? null
          );
        }
        return store.payments.get(where.id as string) ?? null;
      }),
    },
    dispute: {
      findUnique: jest.fn(async ({ where }: { where: Row }) => {
        const row = store.disputes.find((d) => d.disputeId === where.disputeId);
        if (!row) return null;
        // Hydrate the include the handler selects (#738-B tax-parity read).
        const payment = store.payments.get(row.paymentId as string) ?? null;
        return { ...row, payment };
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const created = { id: `disp_row_${store.disputes.length + 1}`, ...data };
        store.disputes.push(created);
        return created;
      }),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = store.disputes.find((d) => d.disputeId === where.disputeId);
        if (row) Object.assign(row, data);
        return row ?? {};
      }),
    },
    consultantEarnings: {
      updateMany: jest.fn(
        async ({ where, data }: { where: Row; data: Row }) => {
          let count = 0;
          for (const e of store.consultantEarnings) {
            if (e.paymentId !== where.paymentId) continue;
            if (where.status && e.status !== where.status) continue;
            if (
              where.preDisputeStatus !== undefined &&
              e.preDisputeStatus !== where.preDisputeStatus
            )
              continue;
            Object.assign(e, data, { id: e.id });
            count++;
          }
          return { count };
        },
      ),
      findMany: jest.fn(async ({ where }: { where: Row }) => {
        const statusIn = (where.status as { in?: string[] } | undefined)?.in;
        // Snapshot copies — real Prisma returns detached row images, and the
        // handler must not observe its own earlier update through them.
        return store.consultantEarnings
          .filter(
            (e) =>
              e.paymentId === where.paymentId &&
              (!statusIn ||
                (statusIn as string[]).includes(e.status as string)),
          )
          .map((e) => ({ ...e }));
      }),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = store.consultantEarnings.find((e) => e.id === where.id);
        if (row) {
          // Resolve Prisma increment operations the way the real client would.
          for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === "object" && "increment" in (v as object)) {
              (data as Row)[k] =
                ((row[k] as number | undefined) ?? 0) +
                (v as { increment: number }).increment;
            }
          }
          Object.assign(row, data);
        }
        return row ?? {};
      }),
    },
    organizationEarnings: {
      updateMany: jest.fn(
        async ({ where, data }: { where: Row; data: Row }) => {
          let count = 0;
          for (const e of store.orgEarnings) {
            if (e.paymentId !== where.paymentId) continue;
            if (where.status && e.status !== where.status) continue;
            if (
              where.preDisputeStatus !== undefined &&
              e.preDisputeStatus !== where.preDisputeStatus
            )
              continue;
            Object.assign(e, data, { id: e.id });
            count++;
          }
          return { count };
        },
      ),
      findMany: jest.fn(async ({ where }: { where: Row }) => {
        const statusIn = (where.status as { in?: string[] } | undefined)?.in;
        return store.orgEarnings
          .filter(
            (e) =>
              e.paymentId === where.paymentId &&
              (!statusIn ||
                (statusIn as string[]).includes(e.status as string)),
          )
          .map((e) => ({ ...e }));
      }),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = store.orgEarnings.find((e) => e.id === where.id);
        if (row) {
          for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === "object" && "increment" in (v as object)) {
              (data as Row)[k] =
                ((row[k] as number | undefined) ?? 0) +
                (v as { increment: number }).increment;
            }
          }
          Object.assign(row, data);
        }
        return row ?? {};
      }),
    },
    billingAccount: { findFirst: jest.fn(async () => null) },
    // applyOrgChargeback / applyB2cChargebackReversal probe this before their
    // posting; these tests stub the appliers themselves, so return "not posted".
    ledgerTransaction: { findUnique: jest.fn(async () => null), create: jest.fn() },
    ledgerEntry: { create: jest.fn() },
    walletTopUp: { findFirst: jest.fn(async () => null) },
    organizationInvoice: { findFirst: jest.fn(async () => null) },
    creditNote: { findUnique: jest.fn(async () => null), create: jest.fn(), aggregate: jest.fn() },
    orgAuditLog: { create: jest.fn(async () => ({})) },
    gstTcsAdjustment: { create: jest.fn(async () => ({})) },
    refund: {
      findUnique: jest.fn(async () => null),
      update: jest.fn(),
      create: jest.fn(),
      // applyOrgChargeback / B2C-reversal net prior SUCCEEDED refunds against
      // the chargeback; the appliers are stubbed, so report zero history.
      aggregate: jest.fn(async () => ({ _sum: { amountPaise: 0 } })),
    },
  };
}

let tx: ReturnType<typeof txStub>;

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
}));

import prisma from "../../lib/prisma";
import {
  handleDisputeCreated,
  handleDisputeUpdated,
} from "../../app/api/webhooks/utils";

const mockedTransaction = prisma.$transaction as unknown as jest.Mock;

function seedPayment(amountPaise: number) {
  store.payments.set("pay_db_1", {
    id: "pay_db_1",
    paymentIntent: "order_ok",
    userId: "user_1",
    amount: amountPaise,
    organizationId: null,
    billingAccountId: null,
    gstTcsCollectedPaise: null,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
  tx = txStub();
  // handleDispute* passes options ({ isolationLevel, maxWait, timeout }) —
  // ignore them and run the callback against the fresh stub.
  mockedTransaction.mockImplementation(
    (fn: (tx: ReturnType<typeof txStub>) => Promise<unknown>) => fn(tx),
  );
  razorpayPaymentsFetch.mockResolvedValue({ order_id: "order_ok" });
});

async function openDispute(amountPaise: number, disputeId = "disp_1") {
  await handleDisputeCreated(
    disputeId,
    "pay_charge_1",
    amountPaise,
    "INR",
    "fraudulent",
    "open",
    null,
    true,
    "RAZORPAY",
  );
}

describe("#1020-1 — hold records the pre-dispute status", () => {
  it("tags PENDING and READY rows with their own prior status", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push(
      { id: "ce_pend", paymentId: "pay_db_1", status: "PENDING" },
      { id: "ce_ready", paymentId: "pay_db_1", status: "READY" },
    );

    await openDispute(5_000);

    expect(store.consultantEarnings.find((e) => e.id === "ce_pend")).toMatchObject({
      status: "HELD",
      preDisputeStatus: "PENDING",
    });
    expect(store.consultantEarnings.find((e) => e.id === "ce_ready")).toMatchObject({
      status: "HELD",
      preDisputeStatus: "READY",
    });
  });

  it("a second dispute on the same payment does NOT clobber the first hold's marker", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push({
      id: "ce_ready",
      paymentId: "pay_db_1",
      status: "READY",
    });

    await openDispute(5_000, "disp_a");
    await openDispute(2_000, "disp_b"); // redelivery / second event

    expect(store.consultantEarnings[0]).toMatchObject({
      status: "HELD",
      preDisputeStatus: "READY",
    });
  });
});

describe("#1020-1 — WON restores the true prior state", () => {
  async function win() {
    // Seed the dispute row directly, then drive the update handler to WON.
    seedPayment(10_000);
    store.disputes.push({
      id: "disp_row_1",
      disputeId: "disp_1",
      status: "NEEDS_RESPONSE",
      amountPaise: 5_000,
      paymentId: "pay_db_1",
    });
    await handleDisputeUpdated("disp_1", "won", null);
  }

  it("a PENDING-held earning returns to PENDING, not READY", async () => {
    store.consultantEarnings.push({
      id: "ce_1",
      paymentId: "pay_db_1",
      status: "HELD",
      preDisputeStatus: "PENDING",
    });

    await win();

    expect(store.consultantEarnings[0]).toMatchObject({
      status: "PENDING",
      preDisputeStatus: null,
    });
  });

  it("a READY-held earning returns to READY", async () => {
    store.consultantEarnings.push({
      id: "ce_1",
      paymentId: "pay_db_1",
      status: "HELD",
      preDisputeStatus: "READY",
    });

    await win();

    expect(store.consultantEarnings[0]).toMatchObject({
      status: "READY",
      preDisputeStatus: null,
    });
  });

  it("legacy rows held before the column shipped still release to READY", async () => {
    store.orgEarnings.push({
      id: "oe_legacy",
      paymentId: "pay_db_1",
      status: "HELD",
      preDisputeStatus: null, // never set
    });

    await win();

    expect(store.orgEarnings[0]).toMatchObject({
      status: "READY",
      preDisputeStatus: null,
    });
  });
});

describe("#1020-3 — LOST reversals are prorated to the disputed fraction", () => {
  it("a half-amount dispute refunds HALF the consultant share, not all of it", async () => {
    seedPayment(10_000); // dispute below is exactly half the payment
    store.consultantEarnings.push({
      id: "ce_1",
      paymentId: "pay_db_1",
      status: "HELD",
      preDisputeStatus: "READY",
      consultantSharePaise: 8_000,
      refundedShareAmount: 0,
      consultantProfileId: "cp_1",
      payoutId: null,
    });
    store.disputes.push({
      id: "disp_row_1",
      disputeId: "disp_1",
      status: "NEEDS_RESPONSE",
      amountPaise: 5_000, // 50%
      paymentId: "pay_db_1",
    });

    await handleDisputeUpdated("disp_1", "lost", null);

    expect(store.consultantEarnings[0]).toMatchObject({
      status: "REFUNDED",
      refundedShareAmount: 4_000, // floor(8000 × 0.5)
    });
  });

  it("a full-amount dispute keeps reversing the whole remaining share", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push({
      id: "ce_1",
      paymentId: "pay_db_1",
      status: "HELD",
      consultantSharePaise: 8_000,
      refundedShareAmount: 500,
      consultantProfileId: "cp_1",
      payoutId: null,
    });
    store.disputes.push({
      id: "disp_row_1",
      disputeId: "disp_1",
      status: "NEEDS_RESPONSE",
      amountPaise: 10_000,
      paymentId: "pay_db_1",
    });

    await handleDisputeUpdated("disp_1", "lost", null);

    // refundedShareAmount is CUMULATIVE: 500 already refunded from an app
    // refund + the capped 7500 reversal now = the full share.
    expect(store.consultantEarnings[0]).toMatchObject({
      refundedShareAmount: 8_000,
    });
    // The reversal itself was capped at the remaining refundable, not the
    // gross proration.
    expect(store.consultantEarnings[0].refundedShareAmount).not.toBe(
      8_500,
    );
  });
});

describe("#1020-2 — already-paid earnings enter the LOST clawback", () => {
  it("PAID consultant earnings flip REFUNDED and page ops ONCE with the total", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push(
      {
        id: "ce_paid1",
        paymentId: "pay_db_1",
        status: "PAID",
        consultantSharePaise: 6_000,
        refundedShareAmount: 0,
        consultantProfileId: "cp_1",
        payoutId: "payout_1",
      },
      {
        id: "ce_paid2",
        paymentId: "pay_db_1",
        status: "PAID",
        consultantSharePaise: 2_000,
        refundedShareAmount: 0,
        consultantProfileId: "cp_2",
        payoutId: null,
      },
    );
    store.disputes.push({
      id: "disp_row_1",
      disputeId: "disp_1",
      status: "NEEDS_RESPONSE",
      amountPaise: 10_000, // full dispute → factor 1
      paymentId: "pay_db_1",
    });

    await handleDisputeUpdated("disp_1", "lost", null);

    expect(store.consultantEarnings.map((e) => e.status)).toEqual([
      "REFUNDED",
      "REFUNDED",
    ]);
    // TDS reversed against the paid-out earning's payout.
    expect(recordTdsReversal).toHaveBeenCalledTimes(1);
    // Exactly ONE ops page carrying the combined manual-recovery total.
    const pages = recordSystemError.mock.calls
      .map((c) => c[0] as { summary: string })
      .filter((c) => c.summary.includes("Chargeback clawback needed"));
    expect(pages).toHaveLength(1);
    expect(pages[0].summary).toContain("8000 paise");
  });

  it("PAID org earnings are clawed back through the reversal engine, prorated", async () => {
    seedPayment(10_000);
    store.orgEarnings.push({
      id: "oe_paid",
      paymentId: "pay_db_1",
      status: "PAID",
      orgSharePaise: 2_000,
      refundedAmountPaise: 0,
      organizationId: "org_1",
      orgPayoutId: "opayout_1",
      orgPayout: { status: "COMPLETED" },
    });
    store.disputes.push({
      id: "disp_row_1",
      disputeId: "disp_1",
      status: "NEEDS_RESPONSE",
      amountPaise: 5_000, // 50%
      paymentId: "pay_db_1",
    });

    await handleDisputeUpdated("disp_1", "lost", null);

    expect(store.orgEarnings[0]).toMatchObject({
      status: "REFUNDED",
      refundedAmountPaise: 1_000, // floor(2000 × 0.5)
    });
    expect(applyReversal).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        source: expect.objectContaining({
          kind: "PAYOUT_CLAWBACK",
          orgPayoutId: "opayout_1",
        }),
        amountPaise: 1_000,
      }),
    );
  });
});
