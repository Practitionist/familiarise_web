/**
 * @jest-environment node
 */

/**
 * #1020 findings 1–3 — dispute → earnings hardening in handleDisputeCreated /
 * handleDisputeUpdated (app/api/webhooks/utils.ts).
 *
 * 1. preHoldStatus — the first hold records the prior status and the last
 *    release restores it; each dispute releases only its own EarningsHold.
 * 2. Paid-earning clawback — the LOST loops queried status:HELD only, missing
 *    earnings already paid out before the chargeback landed. Both loops now
 *    include PAID rows; the consultant rail has no auto-clawback, so it flips
 *    state truthfully and pages ops once per dispute with the total.
 * 3. Proration — reversals are floored to `share × deducted/payment`, and a
 *    partially reversed share stays payable for the rest.
 * 4. The webhook and the reconcile-disputes poll settle a verdict through one
 *    function, so either order lands the same rows.
 *
 * The tx stub is typed against real row interfaces (not string-keyed blobs):
 * every fixture field is compile-checked against what the handler reads.
 */

import { Prisma, type DisputeStatus, type EarningStatus } from "@prisma/client";
import { createEarningsHoldStore } from "../fixtures/earnings-hold-store";

/** The payload shape recordSystemError receives (lib/enterprise/system-events). */
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
const razorpayPaymentsFetch = jest.fn<
  Promise<{ order_id: string }>,
  [chargeId: string]
>();
const applyReversal = jest
  .fn<Promise<unknown>, [unknown]>()
  .mockResolvedValue({});
const recordTdsReversal = jest.fn<
  Promise<void>,
  [
    {
      payoutId: string;
      consultantProfileId: string;
      earningsId: string;
      refundAmountPaise: number;
      paymentAmountPaise: number;
    },
  ]
>();

jest.mock("../../lib/enterprise/system-events", () => {
  const recordSystemEvent = jest
    .fn<Promise<void>, []>()
    .mockResolvedValue(undefined);
  return {
    __esModule: true,
    recordSystemError: (...args: Parameters<typeof recordSystemError>) =>
      recordSystemError(...args),
    recordSystemEvent,
    recordSystemErrorSafe: (...args: Parameters<typeof recordSystemError>) =>
      recordSystemError(...args),
    recordSystemEventSafe: recordSystemEvent,
  };
});
// #1221 — the client is lazy-initialized via getRazorpayClient(); the mock
// hands back an object shaped like the SDK surface the handler touches.
jest.mock("../../lib/payments/core/razorpay", () => ({
  __esModule: true,
  getRazorpayClient: () => ({
    payments: {
      fetch: (chargeId: string) => razorpayPaymentsFetch(chargeId),
    },
  }),
  withRazorpaySdkTimeout: (_op: string, fn: () => unknown) => fn(),
}));
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
jest.mock("../../lib/referrals/credit-reversal", () => ({
  voidVestedReferralRewards: jest
    .fn()
    .mockResolvedValue({ reversedPaise: 0, waiversRevoked: 0 }),
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
  applyReversal: (...a: Parameters<typeof applyReversal>) =>
    applyReversal(...a),
}));
jest.mock("../../lib/payments/tax/tds-service", () => ({
  recordTdsReversal: (...a: Parameters<typeof recordTdsReversal>) =>
    recordTdsReversal(...a),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  applyRefundCascade: jest.fn().mockResolvedValue({}),
  mintInvoiceRefundCreditNote: jest.fn(),
  mintRefundCreditNote: jest.fn().mockResolvedValue({ creditNoteId: null }),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  LONG_JOB_TTL_MS: 1,
  withCronLock: (_n: string, _o: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/payments/discovery/dispute-discovery", () => ({
  discoverGatewayDisputes: async () => ({
    listed: 0,
    imported: 0,
    alreadyKnown: 0,
    updated: 0,
    notAdopted: 0,
    unknownPayment: 0,
    errors: [] as string[],
    stoppedShort: null,
    checkpoint: '{"skip":0,"cutRuns":0}',
  }),
}));
const mockGetRazorpayDispute = jest.fn();
jest.mock("../../lib/payments/core/razorpay-disputes", () => ({
  ...jest.requireActual("../../lib/payments/core/razorpay-disputes"),
  getRazorpayDispute: (...a: unknown[]) => mockGetRazorpayDispute(...a),
}));
const mockReleaseClawbackRecovery = jest.fn();
jest.mock("../../lib/payments/payouts/clawback-recovery", () => ({
  ...jest.requireActual("../../lib/payments/payouts/clawback-recovery"),
  releaseClawbackRecovery: (...a: unknown[]) =>
    mockReleaseClawbackRecovery(...a),
}));
const mockDisputeFindMany = jest.fn();
// #1365 — the chargeback path now mints the B2C credit note beside the org one.
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({
  mintConsumerCreditNote: jest
    .fn()
    .mockResolvedValue({ consumerCreditNoteId: null }),
  mintConsumerInvoice: jest.fn().mockResolvedValue({ consumerInvoiceId: null }),
}));

// ---------------------------------------------------------------------------
// Row types — exactly the fields the handler reads/writes. Fixtures are these
// interfaces, so a typo'd or missing field fails compilation, not production.
// ---------------------------------------------------------------------------

interface PaymentRow {
  id: string;
  paymentIntent: string;
  /** #1353 — the gateway `pay_…` id; the second key the handlers match on. */
  gatewayPaymentId?: string | null;
  userId: string;
  amount: number;
  organizationId: string | null;
  billingAccountId: string | null;
}

interface DisputeRow {
  id: string;
  disputeId: string;
  status: DisputeStatus;
  amountPaise: number;
  paymentId: string;
  evidence?: unknown;
  paymentGateway?: string;
  dueBy?: Date | null;
  updatedAt?: Date;
}

interface ConsultantEarningRow {
  id: string;
  paymentId: string;
  status: EarningStatus;
  preHoldStatus?: EarningStatus | null;
  holdUntil?: Date | null;
  consultantSharePaise: number;
  refundedShareAmount: number;
  consultantProfileId: string;
  payoutId: string | null;
  /** The payout as the batched-earnings read saw it. */
  payout?: { status: string } | null;
}

interface OrgEarningRow {
  id: string;
  paymentId: string;
  status: EarningStatus;
  preHoldStatus?: EarningStatus | null;
  holdUntil?: Date | null;
  orgSharePaise: number;
  refundedAmountPaise: number;
  organizationId: string;
  orgPayoutId: string | null;
  orgPayout: { status: string } | null;
}

// ---------------------------------------------------------------------------
// Store + tx stub. The earnings and hold tables are the shared in-memory
// double, so the real hold helper runs against them.
// ---------------------------------------------------------------------------

const holds = createEarningsHoldStore<ConsultantEarningRow, OrgEarningRow>();

const store = {
  payments: new Map<string, PaymentRow>(),
  disputes: [] as DisputeRow[],
  /** ConsultantPayout id → its live status. */
  payouts: new Map<string, string>(),
  consultantEarnings: holds.consultant,
  orgEarnings: holds.org,
};

function resetStore(): void {
  store.payments.clear();
  store.payouts.clear();
  store.disputes.length = 0;
  holds.consultant.length = 0;
  holds.org.length = 0;
  holds.holds.length = 0;
}

function makeTxStub() {
  return {
    ...holds.db,
    payment: {
      findFirst: async ({
        where,
      }: {
        where: { OR?: Array<Record<string, string | undefined>> };
      }) => {
        const clauses = where.OR ?? [];
        return (
          Array.from(store.payments.values()).find((p) =>
            clauses.some(
              (clause) =>
                (clause.paymentIntent !== undefined &&
                  clause.paymentIntent === p.paymentIntent) ||
                (clause.gatewayPaymentId !== undefined &&
                  clause.gatewayPaymentId === p.gatewayPaymentId),
            ),
          ) ?? null
        );
      },
      findUnique: async ({
        where,
      }: {
        where: { paymentIntent?: string; id?: string };
      }) => {
        if (where.paymentIntent) {
          return (
            Array.from(store.payments.values()).find(
              (p) => p.paymentIntent === where.paymentIntent,
            ) ?? null
          );
        }
        return store.payments.get(where.id ?? "") ?? null;
      },
    },
    dispute: {
      findUnique: async ({ where }: { where: { disputeId: string } }) => {
        const row = store.disputes.find((d) => d.disputeId === where.disputeId);
        if (!row) return null;
        return { ...row, payment: store.payments.get(row.paymentId) ?? null };
      },
      create: async ({ data }: { data: Omit<DisputeRow, "id"> }) => {
        const created: DisputeRow = {
          id: `disp_row_${store.disputes.length + 1}`,
          ...data,
        };
        store.disputes.push(created);
        return created;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id?: string; disputeId?: string; status: DisputeStatus };
        data: Partial<DisputeRow>;
      }) => {
        const row = store.disputes.find(
          (d) =>
            (where.id === undefined || d.id === where.id) &&
            (where.disputeId === undefined ||
              d.disputeId === where.disputeId) &&
            d.status === where.status,
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    consultantPayout: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status: { in: string[] } };
        data: { status: string };
      }) => {
        const status = store.payouts.get(where.id);
        if (!status || !where.status.in.includes(status)) return { count: 0 };
        store.payouts.set(where.id, data.status);
        return { count: 1 };
      },
    },
    // Card-funded unless a test says otherwise (FIN-21).
    paymentLeg: { count: async () => 0 },
    // applyOrgChargeback / B2C-reversal net prior SUCCEEDED refunds against
    // the chargeback; the appliers are stubbed, so report zero history.
    refund: {
      findUnique: async () => null,
      update: async () => ({}),
      create: async () => ({}),
      aggregate: async () => ({ _sum: { amountPaise: 0 } }),
    },
    billingAccount: { findFirst: async () => null },
    ledgerTransaction: {
      findUnique: async () => null,
      create: async () => ({}),
    },
    orgAuditLog: { create: async () => ({}) },
  };
}

type TxStub = ReturnType<typeof makeTxStub>;

let tx: TxStub;

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    // reconcile-disputes reads the open disputes through the global client.
    dispute: { findMany: (...a: unknown[]) => mockDisputeFindMany(...a) },
  },
}));

import prisma from "../../lib/prisma";
import {
  handleDisputeCreated,
  handleDisputeUpdated,
} from "../../app/api/webhooks/utils";
import { reconcileDisputes } from "../../scripts/disputes/reconcile-disputes";

const mockedTransaction = prisma.$transaction as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
  tx = makeTxStub();
  // handleDispute* passes options ({ isolationLevel, maxWait, timeout }) —
  // ignore them and run the callback against the fresh stub.
  mockedTransaction.mockImplementation((fn: (tx: TxStub) => Promise<unknown>) =>
    fn(tx),
  );
  razorpayPaymentsFetch.mockResolvedValue({ order_id: "order_ok" });
  mockDisputeFindMany.mockImplementation(async () =>
    store.disputes
      .filter((d) => ["NEEDS_RESPONSE", "UNDER_REVIEW"].includes(d.status))
      .map((d) => ({
        ...d,
        paymentGateway: "RAZORPAY",
        payment: {
          ...store.payments.get(d.paymentId),
          gatewayPaymentId: "pay_charge_1",
        },
      })),
  );
});

function seedPayment(amountPaise: number): void {
  store.payments.set("pay_db_1", {
    id: "pay_db_1",
    paymentIntent: "order_ok",
    userId: "user_1",
    amount: amountPaise,
    organizationId: null,
    billingAccountId: null,
  });
}

async function openDispute(
  amountPaise: number,
  disputeId = "disp_1",
): Promise<void> {
  await handleDisputeCreated(
    disputeId,
    "pay_charge_1",
    amountPaise,
    "INR",
    "fraudulent",
    "open",
    null,
    true,
  );
}

async function seedOpenDispute(amountPaise: number): Promise<void> {
  store.disputes.push({
    id: "disp_row_1",
    disputeId: "disp_1",
    status: "NEEDS_RESPONSE",
    amountPaise,
    paymentId: "pay_db_1",
  });
}

function ce(
  over: Partial<ConsultantEarningRow> & Pick<ConsultantEarningRow, "id">,
): ConsultantEarningRow {
  return {
    paymentId: "pay_db_1",
    status: "READY",
    preHoldStatus: null,
    holdUntil: null,
    consultantSharePaise: 8_000,
    refundedShareAmount: 0,
    consultantProfileId: "cp_1",
    payoutId: null,
    ...over,
  };
}

function oe(
  over: Partial<OrgEarningRow> & Pick<OrgEarningRow, "id">,
): OrgEarningRow {
  return {
    paymentId: "pay_db_1",
    status: "READY",
    preHoldStatus: null,
    holdUntil: null,
    orgSharePaise: 2_000,
    refundedAmountPaise: 0,
    organizationId: "org_1",
    orgPayoutId: null,
    orgPayout: null,
    ...over,
  };
}

const rowOf = (id: string) =>
  [...store.consultantEarnings, ...store.orgEarnings].find((e) => e.id === id);

describe("#1020-1 — a dispute hold records the prior status", () => {
  test("tags PENDING and READY rows with their own prior status", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push(
      ce({ id: "ce_pend", status: "PENDING" }),
      ce({ id: "ce_ready", status: "READY" }),
    );

    await openDispute(5_000);

    expect(rowOf("ce_pend")).toMatchObject({
      status: "HELD",
      preHoldStatus: "PENDING",
    });
    expect(rowOf("ce_ready")).toMatchObject({
      status: "HELD",
      preHoldStatus: "READY",
    });
    expect(holds.activeReasons("ce_pend")).toEqual(["DISPUTE"]);
  });

  test("a second dispute adds its own hold without clobbering the first's prior", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push(ce({ id: "ce_ready" }));

    await openDispute(5_000, "disp_a");
    await openDispute(2_000, "disp_b");

    expect(rowOf("ce_ready")).toMatchObject({
      status: "HELD",
      preHoldStatus: "READY",
    });
    expect(holds.activeReasons("ce_ready")).toEqual(["DISPUTE", "DISPUTE"]);
  });
});

describe("a dispute pulls a share out of an unsent payout only by cancelling it", () => {
  test.each([
    ["APPROVED", "CANCELLED", "HELD", null],
    ["PROCESSING", "PROCESSING", "BATCHED", "po_1"],
  ] as const)(
    "a payout %s at the cancel ends %s; its earning is %s",
    async (live, payoutAfter, earningAfter, payoutIdAfter) => {
      seedPayment(10_000);
      // The batched read saw APPROVED; `live` is the payout's status at the CAS.
      store.payouts.set("po_1", live);
      store.consultantEarnings.push(
        ce({
          id: "ce_b",
          status: "BATCHED",
          payoutId: "po_1",
          payout: { status: "APPROVED" },
        }),
      );

      await openDispute(10_000);

      expect(store.payouts.get("po_1")).toBe(payoutAfter);
      expect(rowOf("ce_b")).toMatchObject({
        status: earningAfter,
        payoutId: payoutIdAfter,
      });
      expect(mockReleaseClawbackRecovery).toHaveBeenCalledTimes(
        live === "APPROVED" ? 1 : 0,
      );
    },
  );
});

describe("#1020-1 — WON releases this dispute's hold and restores the prior", () => {
  test.each([
    ["PENDING", "PENDING"],
    ["READY", "READY"],
    ["PENDING_TRUST", "PENDING_TRUST"],
  ] as const)("a %s row returns to %s", async (from, to) => {
    seedPayment(10_000);
    store.consultantEarnings.push(ce({ id: "ce_1", status: from }));
    store.orgEarnings.push(oe({ id: "oe_1", status: from }));
    await openDispute(5_000);

    await handleDisputeUpdated("disp_1", "won", null);

    for (const id of ["ce_1", "oe_1"]) {
      expect(rowOf(id)).toMatchObject({ status: to, preHoldStatus: null });
      expect(holds.activeReasons(id)).toEqual([]);
    }
  });

  test("a sibling dispute's hold keeps the row HELD", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push(ce({ id: "ce_1" }));
    await openDispute(5_000, "disp_1");
    await openDispute(2_000, "disp_2");

    await handleDisputeUpdated("disp_1", "won", null);

    expect(rowOf("ce_1")?.status).toBe("HELD");
    expect(holds.activeReasons("ce_1")).toEqual(["DISPUTE"]);
  });
});

describe("FIN-15 — a partial loss leaves the remainder payable", () => {
  test("half deducted: half the share reversed, the row back to READY", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push(ce({ id: "ce_1" }));
    store.orgEarnings.push(oe({ id: "oe_1" }));
    await openDispute(10_000);

    await handleDisputeUpdated("disp_1", "lost", null, null, 5_000);

    expect(rowOf("ce_1")).toMatchObject({
      status: "READY",
      refundedShareAmount: 4_000, // floor(8000 × 0.5)
    });
    expect(rowOf("oe_1")).toMatchObject({
      status: "READY",
      refundedAmountPaise: 1_000,
    });
    expect(holds.activeReasons("ce_1")).toEqual([]);
  });

  test("a full loss reverses the whole remaining share and terminalises the row", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push(ce({ id: "ce_1", refundedShareAmount: 500 }));
    await openDispute(10_000);

    await handleDisputeUpdated("disp_1", "lost", null);

    expect(rowOf("ce_1")).toMatchObject({
      status: "REFUNDED",
      refundedShareAmount: 8_000,
    });
  });
});

describe("FIN-27 — Razorpay `closed` is a loss only for what it deducted", () => {
  test("closed with nothing deducted releases the hold", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push(ce({ id: "ce_1" }));
    await openDispute(10_000);

    await handleDisputeUpdated("disp_1", "closed", null, null, 0);

    expect(rowOf("ce_1")).toMatchObject({
      status: "READY",
      refundedShareAmount: 0,
    });
  });

  test("closed with an amount deducted reverses that amount", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push(ce({ id: "ce_1" }));
    await openDispute(10_000);

    await handleDisputeUpdated("disp_1", "closed", null, null, 10_000);

    expect(rowOf("ce_1")).toMatchObject({
      status: "REFUNDED",
      refundedShareAmount: 8_000,
    });
  });
});

describe("FIN-08 — the poll and the webhook settle a verdict identically", () => {
  async function run(order: "webhook-then-poll" | "poll-then-webhook") {
    resetStore();
    jest.clearAllMocks();
    seedPayment(10_000);
    store.consultantEarnings.push(ce({ id: "ce_1" }));
    store.orgEarnings.push(oe({ id: "oe_1" }));
    await openDispute(10_000);
    mockGetRazorpayDispute.mockResolvedValue({
      disputeId: "disp_1",
      status: "lost",
      evidence: {},
      isChargeRefundable: false,
      dueBy: undefined,
      paymentId: "pay_charge_1",
      amountDeductedPaise: 5_000,
    });
    const webhook = () =>
      handleDisputeUpdated("disp_1", "lost", null, null, 5_000);
    const poll = () => reconcileDisputes();
    for (const step of order === "webhook-then-poll"
      ? [webhook, poll]
      : [poll, webhook]) {
      await step();
    }
    return {
      dispute: store.disputes.map((d) => d.status),
      earnings: [...store.consultantEarnings, ...store.orgEarnings].map(
        (e) => ({ ...e }),
      ),
      holds: holds.holds.map((h) => ({
        reason: h.reason,
        sourceRef: h.sourceRef,
        released: h.releasedAt !== null,
      })),
      reversals: applyReversal.mock.calls.length,
      tdsReversals: recordTdsReversal.mock.calls.length,
    };
  }

  test("webhook-then-poll and poll-then-webhook land the same rows", async () => {
    const a = await run("webhook-then-poll");
    const b = await run("poll-then-webhook");

    expect(b).toEqual(a);
    expect(a.dispute).toEqual(["LOST"]);
    expect(a.earnings.map((e) => e.status)).toEqual(["READY", "READY"]);
    expect(a.holds.every((h) => h.released)).toBe(true);
  });
});

describe("#1020-2 — already-paid earnings enter the LOST clawback", () => {
  test("PAID consultant earnings flip REFUNDED and page ops ONCE with the total", async () => {
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
    await seedOpenDispute(10_000); // full dispute → factor 1

    await handleDisputeUpdated("disp_1", "lost", null);

    expect(store.consultantEarnings.map((e) => e.status)).toEqual([
      "REFUNDED",
      "REFUNDED",
    ]);
    // TDS reversed against the paid-out earning's payout.
    expect(recordTdsReversal).toHaveBeenCalledTimes(1);
    // Exactly ONE ops page carrying the combined manual-recovery total —
    // dispatched POST-commit, so an aborted tx can never page (see below).
    const pages = recordSystemError.mock.calls
      .map(([payload]) => payload.summary)
      .filter((summary) => summary.includes("Chargeback clawback needed"));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("8000 paise");
  });

  test("an aborted transaction never pages — the page is post-commit", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push({
      id: "ce_paid1",
      paymentId: "pay_db_1",
      status: "PAID",
      consultantSharePaise: 6_000,
      refundedShareAmount: 0,
      consultantProfileId: "cp_1",
      payoutId: "payout_1",
    });
    await seedOpenDispute(10_000);

    // SSI abort: prisma.$transaction rejects after the handler staged the page.
    mockedTransaction.mockImplementationOnce(async () => {
      throw new Error("P2034 serialization failure");
    });

    await expect(handleDisputeUpdated("disp_1", "lost", null)).rejects.toThrow(
      /serialization failure/,
    );

    const clawbackPages = recordSystemError.mock.calls
      .map(([payload]) => payload.summary)
      .filter((summary) => summary.includes("Chargeback clawback needed"));
    expect(clawbackPages).toHaveLength(0);
  });

  test("PAID org earnings are clawed back through the reversal engine, prorated", async () => {
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
    await seedOpenDispute(5_000); // 50%

    await handleDisputeUpdated("disp_1", "lost", null);

    // Half reversed: the paid share stays PAID with the reversal recorded.
    expect(store.orgEarnings[0]).toMatchObject({
      status: "PAID",
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

describe("#1582 C-P1-01d — handleDisputeUpdated retries a serialization abort", () => {
  test("a first-attempt P2034 is retried in-process, not rethrown", async () => {
    seedPayment(10_000);
    await seedOpenDispute(5_000);
    mockedTransaction.mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError("could not serialize", {
        code: "P2034",
        clientVersion: "test",
      });
    });

    await expect(
      handleDisputeUpdated("disp_1", "won", null),
    ).resolves.toBeUndefined();

    // The aborted attempt and the retry each opened a transaction, and the
    // retry's commit landed the status.
    expect(mockedTransaction).toHaveBeenCalledTimes(2);
    expect(store.disputes[0].status).toBe("WON");
  });
});
