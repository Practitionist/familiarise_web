/**
 * @jest-environment node
 */

/**
 * The automatic consultant clawback for a LOST dispute on a PAID earning, wired
 * into `handleDisputeUpdated` (app/api/webhooks/utils.ts).
 *
 * What this pins:
 *
 *   1. a lost dispute on a PAID earning whose `ConsultantPayout` COMPLETED
 *      drives exactly ONE `applyReversal({ kind: "CONSULTANT_CLAWBACK" })`;
 *   2. the clawback amount is derived from the SAME `reversalNow` integer the
 *      earnings reversal posted to `refundedShareAmount` — never a second
 *      derivation of the proration factor, so a partial dispute cannot round
 *      two ways. The GROSS→NET scale is then applied to that one integer, so
 *      the two DIVERGE exactly and only by the withheld TDS: the earnings
 *      reversal is gross (it measures earnings, not cash) while the receivable
 *      is net (it recovers what was disbursed). With no TDS they coincide by
 *      arithmetic, not by assumption; with TDS they must not.
 *   3. a second delivery of the same LOST webhook posts nothing;
 *   4. the no-PAYOUT case is untouched — a HELD earning, a PAID earning with no
 *      `payoutId`, and a PAID earning whose payout has NOT completed all reverse
 *      the earnings without ever calling the engine;
 *   5. several earnings sharing one batch payout produce ONE clawback carrying
 *      the summed amount (the per-(dispute, payout) key would otherwise collide
 *      and drop the rest).
 *
 * `applyReversal` is stubbed: the journal it writes is asserted in
 * `consultant-payout-clawback.test.ts`. What matters here is routing, proration
 * parity and idempotency at the call site.
 */

import type { DisputeStatus, EarningStatus, PayoutStatus } from "@prisma/client";

interface SystemErrorPayload {
  organizationId?: string | null;
  category?: string;
  summary: string;
  err?: unknown;
  context?: Record<string, unknown>;
}

const recordSystemError = jest
  .fn<Promise<void>, [SystemErrorPayload]>()
  .mockResolvedValue(undefined);
const applyReversal = jest
  .fn<Promise<unknown>, [unknown, unknown]>()
  .mockResolvedValue({ kind: "CONSULTANT_CLAWBACK", clawbackPosted: true });
const recordTdsReversal = jest.fn<Promise<void>, [unknown]>().mockResolvedValue();

jest.mock("../../lib/enterprise/system-events", () => {
  const recordSystemEvent = jest.fn<Promise<void>, []>().mockResolvedValue();
  return {
    __esModule: true,
    recordSystemError: (...a: [SystemErrorPayload]) => recordSystemError(...a),
    recordSystemEvent,
    recordSystemErrorSafe: (...a: [SystemErrorPayload]) =>
      recordSystemError(...a),
    recordSystemEventSafe: recordSystemEvent,
  };
});
jest.mock("../../lib/payments/core/razorpay", () => ({
  __esModule: true,
  getRazorpayClient: () => ({ payments: { fetch: async () => ({}) } }),
}));
jest.mock("../../lib/payments/core/stripe", () => ({ stripeClient: null }));
jest.mock("../../lib/novu", () => ({
  notifyRefundProcessed: jest.fn(),
  notifyDisputeCreated: jest.fn(),
  notifyDisputeResolved: jest.fn().mockResolvedValue({ staged: null }),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgInvoicePaid: jest.fn(),
  notifyOrgWalletTopupConfirmed: jest.fn(),
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
}));
jest.mock("../../lib/payments/webhooks/handlers", () => ({
  handlePaymentSuccess: jest.fn(),
  handlePaymentFailure: jest.fn(),
}));
jest.mock("../../lib/payments/operations/reversal-engine", () => ({
  applyReversal: (...a: [unknown, unknown]) => applyReversal(...a),
  // The real pure function — the clawback keys it emits are asserted below.
  consultantClawbackKey: (refundId: string, payoutId: string) =>
    `clawback:${refundId}:${payoutId}`,
}));
jest.mock("../../lib/payments/tax/tds-service", () => ({
  recordTdsReversal: (...a: [unknown]) => recordTdsReversal(...a),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  applyRefundCascade: jest.fn().mockResolvedValue({}),
  mintInvoiceRefundCreditNote: jest.fn(),
  mintRefundCreditNote: jest.fn().mockResolvedValue({ creditNoteId: null }),
}));
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({
  mintConsumerCreditNote: jest
    .fn()
    .mockResolvedValue({ consumerCreditNoteId: null }),
  mintConsumerInvoice: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
}));

import prisma from "../../lib/prisma";
import { handleDisputeUpdated } from "../../app/api/webhooks/utils";

const mockedTransaction = prisma.$transaction as unknown as jest.Mock;

// --- rows -------------------------------------------------------------------

interface PaymentRow {
  id: string;
  paymentIntent: string;
  userId: string;
  amount: number;
  organizationId: string | null;
  billingAccountId: string | null;
  gstTcsCollectedPaise: number | null;
}

interface DisputeRow {
  id: string;
  disputeId: string;
  status: DisputeStatus;
  amountPaise: number;
  paymentId: string;
}

interface ConsultantEarningRow {
  id: string;
  paymentId: string;
  status: EarningStatus;
  consultantSharePaise: number;
  refundedShareAmount: number;
  consultantProfileId: string;
  payoutId: string | null;
  /**
   * The relation the handler selects: `status` gates on "the cash actually
   * left", and `amount` + `tdsDeducted` give the GROSS→NET scale for the
   * clawback (W1a). Both optional in the fixture so a payout with no TDS (or a
   * partial select) still scales to exactly 1.
   */
  payout: {
    status: PayoutStatus;
    /** `ConsultantPayout.amount` — the GROSS. Named to match the handler's select. */
    amount?: number;
    tdsDeducted?: number;
  } | null;
}

const store: {
  payments: Map<string, PaymentRow>;
  disputes: DisputeRow[];
  consultantEarnings: ConsultantEarningRow[];
} = { payments: new Map(), disputes: [], consultantEarnings: [] };

function makeTxStub() {
  return {
    payment: {
      findFirst: async () => null,
      findUnique: async ({ where }: { where: { id?: string } }) =>
        store.payments.get(where.id ?? "") ?? null,
    },
    dispute: {
      findUnique: async ({ where }: { where: { disputeId: string } }) => {
        const row = store.disputes.find((d) => d.disputeId === where.disputeId);
        if (!row) return null;
        return { ...row, payment: store.payments.get(row.paymentId) ?? null };
      },
      create: async () => ({}),
      update: async ({ where, data }: { where: { disputeId: string }; data: Partial<DisputeRow> }) => {
        const row = store.disputes.find((d) => d.disputeId === where.disputeId);
        if (!row) return null;
        Object.assign(row, data);
        return row;
      },
    },
    consultantEarnings: {
      updateMany: async () => ({ count: 0 }),
      findMany: async ({ where }: { where: { paymentId: string; status?: { in: EarningStatus[] } } }) =>
        store.consultantEarnings
          .filter(
            (e) =>
              e.paymentId === where.paymentId &&
              (!where.status || where.status.in.includes(e.status)),
          )
          .map((e) => ({ ...e })),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.consultantEarnings.find((e) => e.id === where.id);
        if (!row) return null;
        for (const [k, v] of Object.entries(data)) {
          const cur = (row as unknown as Record<string, unknown>)[k];
          (row as unknown as Record<string, unknown>)[k] =
            v !== null && typeof v === "object" && "increment" in (v as object)
              ? (((cur as number | null) ?? 0) +
                  (v as { increment: number }).increment)
              : v;
        }
        return row;
      },
    },
    organizationEarnings: {
      updateMany: async () => ({ count: 0 }),
      findMany: async () => [],
      update: async () => null,
    },
    refund: {
      findUnique: async () => null,
      update: async () => ({}),
      create: async () => ({}),
      aggregate: async () => ({ _sum: { amountPaise: 0 } }),
    },
    billingAccount: { findFirst: async () => null },
    // null ⇒ applyB2cChargebackReversal bails (no booking journal to mirror).
    // That path is covered by its own suite; here it just stays quiet.
    ledgerTransaction: { findUnique: async () => null, create: async () => ({}) },
    orgAuditLog: { create: async () => ({}) },
    gstTcsAdjustment: { create: async () => ({}) },
  };
}

let tx: ReturnType<typeof makeTxStub>;

function seedPayment(amountPaise: number): void {
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

function seedOpenDispute(amountPaise: number): void {
  store.disputes.push({
    id: "disp_row_1",
    disputeId: "disp_1",
    status: "NEEDS_RESPONSE",
    amountPaise,
    paymentId: "pay_db_1",
  });
}

function seedEarning(
  over: Partial<ConsultantEarningRow> & Pick<ConsultantEarningRow, "id">,
): void {
  store.consultantEarnings.push({
    paymentId: "pay_db_1",
    status: "PAID",
    consultantSharePaise: 6_000,
    refundedShareAmount: 0,
    consultantProfileId: "cp_1",
    payoutId: "cpay_1",
    payout: { status: "COMPLETED", amount: 10_000, tdsDeducted: 0 },
    ...over,
  });
}

/** The single CONSULTANT_CLAWBACK call the handler made, if any. */
function consultantClawbackCalls() {
  return applyReversal.mock.calls
    .map(([, input]) => input as {
      source: {
        kind: string;
        consultantPayoutId: string;
        consultantProfileId: string;
      };
      amountPaise: number;
      refundId: string;
    })
    .filter((i) => i.source.kind === "CONSULTANT_CLAWBACK");
}

beforeEach(() => {
  jest.clearAllMocks();
  store.payments.clear();
  store.disputes.length = 0;
  store.consultantEarnings.length = 0;
  tx = makeTxStub();
  mockedTransaction.mockImplementation((fn: (t: typeof tx) => Promise<unknown>) =>
    fn(tx),
  );
});

describe("LOST dispute on a PAID consultant earning — the clawback", () => {
  test("posts exactly one clawback, prorated to the dispute, with the earnings reversal's own integer", async () => {
    seedPayment(10_000);
    seedEarning({ id: "ce_paid", consultantSharePaise: 6_000 });
    seedOpenDispute(5_000); // 50 % of the payment

    await handleDisputeUpdated("disp_1", "lost", null);

    // The earnings reversal is unchanged and still the source of truth.
    expect(store.consultantEarnings[0]).toMatchObject({
      status: "REFUNDED",
      refundedShareAmount: 3_000, // floor(6000 × 0.5)
    });

    const calls = consultantClawbackCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toEqual({
      kind: "CONSULTANT_CLAWBACK",
      consultantPayoutId: "cpay_1",
      consultantProfileId: "cp_1",
    });
    // GROSS vs NET. The earnings reversal stays GROSS (`refundedShareAmount`
    // measures earnings, not cash). The clawback is the NET actually
    // disbursed. This payout withholds no TDS, so the scale is exactly 1 and
    // the two coincide — which is the point: identity is a consequence of the
    // arithmetic, not an assumption. The TDS case is pinned separately below.
    expect(calls[0].amountPaise).toBe(
      store.consultantEarnings[0].refundedShareAmount,
    );
    expect(calls[0].amountPaise).toBe(3_000);
    expect(calls[0].refundId).toBe("dispute:disp_row_1");
  });

  test("the clawback is NET of TDS — it never reclaims the withheld tax", async () => {
    seedPayment(10_000);
    // Gross payout 10_000, TDS withheld 1_000, so the consultant received 9_000.
    seedEarning({
      id: "ce_paid",
      consultantSharePaise: 6_000,
      payout: { status: "COMPLETED", amount: 10_000, tdsDeducted: 1_000 },
    });
    seedOpenDispute(5_000); // 50 % of the payment

    await handleDisputeUpdated("disp_1", "lost", null);

    // Earnings are reversed GROSS: the whole 3_000 share is no longer earned.
    expect(store.consultantEarnings[0].refundedShareAmount).toBe(3_000);

    // The receivable is NET: 3_000 × (1 − 1_000/10_000) = 2_700. Clawing back
    // the gross would demand 300 paise the platform never sent — and that
    // 300 is the tax, which `recordTdsReversal` owns, not us.
    const calls = consultantClawbackCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].amountPaise).toBe(2_700);
    expect(calls[0].amountPaise).toBeLessThan(
      store.consultantEarnings[0].refundedShareAmount as number,
    );
  });

  test("a TDS-free payout claws back the full gross (scale is exactly 1)", async () => {
    seedPayment(10_000);
    seedEarning({
      id: "ce_paid",
      consultantSharePaise: 6_000,
      payout: { status: "COMPLETED", amount: 10_000, tdsDeducted: 0 },
    });
    seedOpenDispute(5_000);

    await handleDisputeUpdated("disp_1", "lost", null);

    expect(consultantClawbackCalls()[0].amountPaise).toBe(3_000);
  });

  test("a second delivery of the same LOST webhook posts nothing", async () => {
    seedPayment(10_000);
    seedEarning({ id: "ce_paid", consultantSharePaise: 6_000 });
    seedOpenDispute(10_000);

    await handleDisputeUpdated("disp_1", "lost", null);
    expect(consultantClawbackCalls()).toHaveLength(1);

    // Redelivery: the dispute is already LOST, so the handler no-ops before the
    // earnings loop and never re-derives a key.
    await handleDisputeUpdated("disp_1", "lost", null);
    expect(consultantClawbackCalls()).toHaveLength(1);
    expect(store.consultantEarnings[0].refundedShareAmount).toBe(6_000);
  });

  test("earnings sharing one batch payout become ONE clawback carrying the sum", async () => {
    seedPayment(10_000);
    seedEarning({
      id: "ce_a",
      consultantSharePaise: 3_000,
      payoutId: "cpay_1",
      payout: { status: "COMPLETED" },
    });
    seedEarning({
      id: "ce_b",
      consultantSharePaise: 2_000,
      payoutId: "cpay_1",
      payout: { status: "COMPLETED" },
    });
    seedEarning({
      id: "ce_c",
      consultantSharePaise: 1_000,
      payoutId: "cpay_2",
      payout: { status: "COMPLETED" },
    });
    seedOpenDispute(10_000);

    await handleDisputeUpdated("disp_1", "lost", null);

    // Two payouts ⇒ two postings. Posting per-earning would have derived the
    // SAME `clawback:dispute:disp_row_1:cpay_1` key for ce_a and ce_b, so ce_b
    // would have been dropped as a replay and 2000 paise lost.
    const calls = consultantClawbackCalls();
    expect(calls).toHaveLength(2);
    const byPayout = new Map(calls.map((c) => [c.source.consultantPayoutId, c.amountPaise]));
    expect(byPayout.get("cpay_1")).toBe(5_000);
    expect(byPayout.get("cpay_2")).toBe(1_000);
    // …and the clawbacks still sum to the earnings reversals, exactly.
    const reversed = store.consultantEarnings.reduce(
      (s, e) => s + e.refundedShareAmount,
      0,
    );
    expect([...byPayout.values()].reduce((s, n) => s + n, 0)).toBe(reversed);
  });
});

describe("LOST dispute — cases with no cash out stay untouched", () => {
  test("a HELD earning reverses without ever calling the engine", async () => {
    seedPayment(10_000);
    seedEarning({ id: "ce_held", status: "HELD", consultantSharePaise: 6_000 });
    seedOpenDispute(10_000);

    await handleDisputeUpdated("disp_1", "lost", null);

    expect(store.consultantEarnings[0]).toMatchObject({
      status: "REFUNDED",
      refundedShareAmount: 6_000,
    });
    expect(consultantClawbackCalls()).toHaveLength(0);
  });

  test("a PAID earning with no payoutId is still paged but never clawed back", async () => {
    seedPayment(10_000);
    seedEarning({ id: "ce_orphan", payoutId: null, consultantSharePaise: 6_000 });
    seedOpenDispute(10_000);

    await handleDisputeUpdated("disp_1", "lost", null);

    expect(store.consultantEarnings[0].refundedShareAmount).toBe(6_000);
    expect(consultantClawbackCalls()).toHaveLength(0);
    // The page is what catches this case — with no journal behind it.
    const pages = recordSystemError.mock.calls
      .map(([p]) => p.summary)
      .filter((s) => s.includes("Chargeback clawback needed"));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("none — collect by hand");
  });

  test("a PAID earning whose payout has not completed is not clawed back", async () => {
    seedPayment(10_000);
    seedEarning({
      id: "ce_batched",
      // PROCESSING, not BATCHED: BATCHED is an EARNING status, and a
      // ConsultantPayout is never in it. PROCESSING is the real
      // "submitted, cash not confirmed out" state — the submitted-but-unsettled
      // window where clawing back would demand money that may never have moved.
      payout: { status: "PROCESSING" },
      consultantSharePaise: 6_000,
    });
    seedOpenDispute(10_000);

    await handleDisputeUpdated("disp_1", "lost", null);

    expect(store.consultantEarnings[0].refundedShareAmount).toBe(6_000);
    expect(consultantClawbackCalls()).toHaveLength(0);
  });
});

describe("the ops page survives the clawback", () => {
  test("one page per dispute, carrying the journal keys to reconcile against", async () => {
    seedPayment(10_000);
    seedEarning({ id: "ce_paid", consultantSharePaise: 6_000 });
    seedEarning({
      id: "ce_b",
      consultantSharePaise: 2_000,
      payoutId: "cpay_2",
    });
    seedOpenDispute(10_000);

    await handleDisputeUpdated("disp_1", "lost", null);

    const pages = recordSystemError.mock.calls
      .map(([p]) => p)
      .filter((p) => p.summary.includes("Chargeback clawback needed"));
    expect(pages).toHaveLength(1);
    expect(pages[0].summary).toContain("8000 paise");
    // The page names WHICH dispute and WHICH earnings to collect, and the
    // ledger keys of the receivables booked against them — neither of which
    // the journal alone carries.
    expect(pages[0].context).toMatchObject({
      disputeId: "disp_1",
      paymentId: "pay_db_1",
      earnings: 2,
      amountPaise: 8_000,
      clawbackKeys: [
        "clawback:dispute:disp_row_1:cpay_1",
        "clawback:dispute:disp_row_1:cpay_2",
      ],
    });
  });
});
