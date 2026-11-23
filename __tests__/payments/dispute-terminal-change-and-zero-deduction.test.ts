/**
 * @jest-environment node
 */

/**
 * Dispute events that do not fit one status and one optional amount:
 * a status change or later phase on a terminal dispute is recorded and changes
 * nothing, and a LOST verdict reporting 0 or nothing deducted is settled on the
 * disputed amount. Driven through the real dispatch and the real reconcile poll
 * against strict client doubles, so a missing delegate method throws.
 */

import type { Tx } from "@/lib/prisma";
import {
  applyData,
  matchesWhere,
  type Row,
  type Where,
} from "../fixtures/mem-db";
import { createEarningsHoldStore } from "../fixtures/earnings-hold-store";
import { strictTxDouble } from "../fixtures/tx-double";

const mockApplyReversal = jest.fn(async (..._a: unknown[]) => ({
  clawbackPosted: true,
}));
const mockPostLedgerTxn = jest.fn(async (..._a: unknown[]) => ({}));
const mockMintRefundCreditNote = jest.fn(async (..._a: unknown[]) => ({
  creditNoteId: null,
}));
const mockMintConsumerCreditNote = jest.fn(async (..._a: unknown[]) => ({
  consumerCreditNoteId: null,
}));
const mockGetRazorpayDispute = jest.fn();

jest.mock("@/lib/prisma", () => {
  const { strictClientDouble } = jest.requireActual<
    typeof import("../fixtures/tx-double")
  >("../fixtures/tx-double");
  return {
    __esModule: true,
    default: strictClientDouble(
      {
        $transaction: (fn: (tx: Tx) => Promise<unknown>) =>
          mockRunTransaction(fn),
        payment: { findFirst: (a: { where: Where }) => mockFindPayment(a) },
        dispute: { findMany: (a: { where: Where }) => mockFindDisputes(a) },
        webhookEvent: {
          update: (a: { where: { eventId: string }; data: Row }) =>
            mockMarkWebhook(a),
        },
        systemEvent: {
          create: (a: { data: Row }) => mockCreateEvent("global", a),
        },
      },
      "prisma",
    ),
  };
});
jest.mock("@/lib/payments/core/razorpay", () => ({
  __esModule: true,
  getRazorpayClient: () => null,
  withRazorpaySdkTimeout: (_op: string, fn: () => unknown) => fn(),
}));
jest.mock("@/lib/payments/core/razorpay-disputes", () => ({
  ...jest.requireActual("@/lib/payments/core/razorpay-disputes"),
  getRazorpayDispute: (...a: unknown[]) => mockGetRazorpayDispute(...a),
}));
jest.mock("@/lib/cron/with-cron-lock", () => ({
  LONG_JOB_TTL_MS: 1,
  withCronLock: (_n: string, _o: unknown, fn: () => unknown) => fn(),
}));
jest.mock("@/lib/novu", () => ({
  notifyRefundProcessed: jest.fn(),
  attemptTrigger: jest.fn(),
  notifyDisputeCreated: jest.fn(async () => []),
  notifyDisputeResolved: jest.fn(async () => []),
}));
jest.mock("@/lib/email/senders/money", () => ({
  ...jest.requireActual("@/lib/email/senders/money"),
  stageDisputeNoticeEmail: jest.fn(async () => []),
}));
jest.mock("@/lib/observability/betterstack-telemetry", () => ({
  ...jest.requireActual("@/lib/observability/betterstack-telemetry"),
  emitTelemetryLog: jest.fn(async () => undefined),
}));
jest.mock("@/lib/payments/payouts/cancel-open-payouts", () => ({
  cancelOpenPayoutsForPayment: jest.fn(async () => undefined),
}));
jest.mock("@/lib/payments/operations/reversal-engine", () => ({
  applyReversal: (...a: unknown[]) => mockApplyReversal(...a),
  consultantClawbackKey: (refundId: string, payoutId: string) =>
    `clawback:${refundId}:${payoutId}`,
}));
jest.mock("@/lib/payments/payouts", () => ({
  handlePayoutWebhook: jest.fn(),
}));
jest.mock("@/lib/payments/ledger/post", () => ({
  ...jest.requireActual("@/lib/payments/ledger/post"),
  postLedgerTxn: (...a: unknown[]) => mockPostLedgerTxn(...a),
}));
jest.mock("@/lib/payments/operations/refund", () => ({
  applyRefundCascade: jest.fn(),
  mintInvoiceRefundCreditNote: jest.fn(),
  remainingOrgInvoiceCreditPaise: jest.fn(),
  mintRefundCreditNote: (...a: unknown[]) => mockMintRefundCreditNote(...a),
}));
jest.mock("@/lib/payments/billing/consumer-invoice", () => ({
  mintConsumerInvoice: jest.fn(),
  mintConsumerCreditNote: (...a: unknown[]) => mockMintConsumerCreditNote(...a),
}));
jest.mock("@/lib/payments/tax/tds-service", () => ({
  recordTdsReversal: jest.fn(async () => undefined),
}));
jest.mock("@/lib/referrals/credit-reversal", () => ({
  voidVestedReferralRewards: jest.fn(async () => ({
    reversedPaise: 0,
    waiversRevoked: 0,
  })),
}));
jest.mock("@/lib/payments/webhooks/handlers", () => ({
  handlePaymentSuccess: jest.fn(),
  handlePaymentFailure: jest.fn(),
}));

import { razorpayWebhookEnvelopeSchema } from "@/schemas/webhooks/razorpay";
import { processRazorpayWebhookEvent } from "@/app/api/webhooks/razorpay-dispatch";
import { reconcileDisputes } from "@/scripts/disputes/reconcile-disputes";

// ---------------------------------------------------------------------------
// World: payments, disputes, earnings and holds, plus every event and mark.
// ---------------------------------------------------------------------------

interface Earning extends Row {
  id: string;
  paymentId: string;
  status: "PENDING" | "READY" | "HELD" | "PAID" | "REFUNDED";
  preHoldStatus: null;
  holdUntil: null;
  consultantSharePaise: number;
  refundedShareAmount: number;
  consultantProfileId: string;
  payoutId: string | null;
  payout: { status: string; amount: number; tdsDeducted: number } | null;
}

const holds = createEarningsHoldStore<Earning>();
const world = {
  payments: [] as Row[],
  disputes: [] as Row[],
  events: [] as Array<{ via: "tx" | "global" } & Row>,
  marks: [] as Array<{ eventId: string; data: Row }>,
};
let tx: Tx;
let seq = 0;

function pick(row: Row | undefined, select?: Record<string, unknown>) {
  if (!row) return null;
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
}

function mockRunTransaction(fn: (t: Tx) => Promise<unknown>) {
  return fn(tx);
}
async function mockFindPayment(a: { where: Where }) {
  const hit = world.payments.find((p) => matchesWhere(p, a.where));
  return hit ? { paymentIntent: hit.paymentIntent } : null;
}
async function mockFindDisputes(a: { where: Where }) {
  return world.disputes
    .filter((d) => matchesWhere(d, a.where))
    .map((d) => ({
      ...d,
      payment: world.payments.find((p) => p.id === d.paymentId) ?? null,
    }));
}
async function mockMarkWebhook(a: { where: { eventId: string }; data: Row }) {
  world.marks.push({ eventId: a.where.eventId, data: a.data });
  return a.data;
}
async function mockCreateEvent(via: "tx" | "global", a: { data: Row }) {
  world.events.push({ via, ...a.data });
  return a.data;
}

function bookingJournal(paymentId: string) {
  const payment = world.payments.find((p) => p.id === paymentId);
  const amount = Number(payment?.amount ?? 0);
  const share = holds.consultant
    .filter((e) => e.paymentId === paymentId)
    .reduce((s, e) => s + e.consultantSharePaise, 0);
  const account = (kind: string) => ({
    kind,
    organizationId: null,
    consultantProfileId: null,
  });
  return {
    id: `ltx_booking_${paymentId}`,
    entries: [
      {
        direction: "DEBIT",
        amountPaise: amount,
        account: account("GATEWAY_CLEARING"),
      },
      {
        direction: "CREDIT",
        amountPaise: share,
        account: account("CONSULTANT_PAYABLE"),
      },
      {
        direction: "CREDIT",
        amountPaise: amount - share,
        account: account("PLATFORM_FEE"),
      },
    ],
  };
}

function makeTx(): Tx {
  return strictTxDouble({
    ...holds.db,
    payment: {
      findFirst: jest.fn(async (a: { where: Where }) =>
        pick(world.payments.find((p) => matchesWhere(p, a.where))),
      ),
      findUnique: jest.fn(
        async (a: { where: Where; select?: Record<string, unknown> }) =>
          pick(
            world.payments.find((p) => matchesWhere(p, a.where)),
            a.select,
          ),
      ),
    },
    dispute: {
      findUnique: jest.fn(
        async (a: {
          where: Where;
          include?: { payment?: { select: Record<string, unknown> } };
        }) => {
          const row = world.disputes.find((d) => matchesWhere(d, a.where));
          if (!row) return null;
          const payment = world.payments.find((p) => p.id === row.paymentId);
          return a.include?.payment
            ? { ...row, payment: pick(payment, a.include.payment.select) }
            : { ...row };
        },
      ),
      create: jest.fn(async (a: { data: Row }) => {
        const now = new Date();
        const row = {
          id: `dsp_row_${++seq}`,
          createdAt: now,
          updatedAt: now,
          ...a.data,
        };
        world.disputes.push(row);
        return { ...row };
      }),
      updateMany: jest.fn(async (a: { where: Where; data: Row }) => {
        let count = 0;
        for (const d of world.disputes) {
          if (!matchesWhere(d, a.where)) continue;
          applyData(d, a.data);
          count++;
        }
        return { count };
      }),
    },
    paymentLeg: { count: jest.fn(async () => 0) },
    refund: {
      aggregate: jest.fn(async () => ({ _sum: { amountPaise: 0 } })),
    },
    ledgerTransaction: {
      findUnique: jest.fn(async (a: { where: { idempotencyKey: string } }) => {
        const key = a.where.idempotencyKey;
        return key.startsWith("booking:")
          ? bookingJournal(key.slice("booking:".length))
          : null;
      }),
    },
    systemEvent: {
      create: jest.fn((a: { data: Row }) => mockCreateEvent("tx", a)),
    },
    // Present in production; the notice stager itself is stubbed above.
    user: { findMany: jest.fn(async () => []) },
    failedEmail: { create: jest.fn() },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  world.payments.length = 0;
  world.disputes.length = 0;
  world.events.length = 0;
  world.marks.length = 0;
  holds.consultant.length = 0;
  holds.org.length = 0;
  holds.holds.length = 0;
  tx = makeTx();
});

// ---------------------------------------------------------------------------
// Fixtures in the shapes the local replays used.
// ---------------------------------------------------------------------------

function seedPayment(id: string, amount: number): void {
  world.payments.push({
    id,
    paymentIntent: `order_${id}`,
    gatewayPaymentId: `pay_gw_${id}`,
    paymentStatus: "SUCCEEDED",
    userId: "user_1",
    amount,
    organizationId: null,
    billingAccountId: null,
    appointmentId: `appt_${id}`,
    createdAt: new Date(),
  });
}

function earning(
  id: string,
  paymentId: string,
  over: Partial<Earning>,
): Earning {
  return {
    id,
    paymentId,
    status: "PENDING",
    preHoldStatus: null,
    holdUntil: null,
    consultantSharePaise: 0,
    refundedShareAmount: 0,
    consultantProfileId: "cp_1",
    payoutId: null,
    payout: null,
    ...over,
  };
}

/** A ₹6,000 subscription payment with four PENDING shares. */
function seedSubscription(): void {
  seedPayment("pay_sub", 600_000);
  for (let i = 1; i <= 4; i++) {
    holds.consultant.push(
      earning(`ce_sub_${i}`, "pay_sub", { consultantSharePaise: 120_000 }),
    );
  }
}

/** A ₹113 trial payment whose 9,040-paise share was paid out. */
function seedPaidTrial(): void {
  seedPayment("pay_trial", 11_300);
  holds.consultant.push(
    earning("ce_trial", "pay_trial", {
      status: "PAID",
      consultantSharePaise: 9_040,
      payoutId: "cpo_1",
      payout: { status: "COMPLETED", amount: 9_040, tdsDeducted: 0 },
    }),
  );
}

let delivery = 0;

/** One signed-replay equivalent: parse the envelope, dispatch it, require a clean mark. */
async function deliver(
  eventType: string,
  dispute: Row & { id: string; payment_id: string },
): Promise<void> {
  const eventId = `${eventType}:${dispute.id}:evt_${++delivery}`;
  const envelope = razorpayWebhookEnvelopeSchema.parse({
    entity: "event",
    event: eventType,
    contains: ["payment", "dispute"],
    payload: {
      payment: { entity: { id: dispute.payment_id, order_id: null } },
      dispute: {
        entity: {
          entity: "dispute",
          currency: "INR",
          reason_code: "chargeback",
          reason_description: "Goods not received",
          respond_by: Math.floor(Date.now() / 1000) + 2 * 86_400,
          amount_deducted: 0,
          ...dispute,
        },
      },
    },
  });
  await processRazorpayWebhookEvent(envelope, eventType, eventId);
  const mark = world.marks.find((m) => m.eventId === eventId);
  expect(mark?.data).toMatchObject({ processed: true, error: null });
}

const errorEvents = () => world.events.filter((e) => e.severity === "ERROR");
const infoEvents = () =>
  world.events.filter(
    (e) => e.severity === "INFO" && e.category === "razorpay_webhook",
  );
const ce = (id: string) => holds.consultant.find((e) => e.id === id);
const disputeStatus = (disputeId: string) =>
  world.disputes.find((d) => d.disputeId === disputeId)?.status;

// ---------------------------------------------------------------------------
// Entry 1: a change out of a terminal status is recorded, never dropped.
// ---------------------------------------------------------------------------

describe("a terminal dispute that the gateway reports differently", () => {
  const SUB = { id: "disp_sub", payment_id: "pay_gw_pay_sub", amount: 600_000 };

  test("won then lost on one id writes one ERROR event and moves no status or money", async () => {
    seedSubscription();
    await deliver("payment.dispute.created", {
      ...SUB,
      status: "open",
      phase: "chargeback",
    });
    await deliver("payment.dispute.won", {
      ...SUB,
      status: "won",
      phase: "chargeback",
    });

    await deliver("payment.dispute.lost", {
      ...SUB,
      status: "lost",
      phase: "chargeback",
      amount_deducted: 600_000,
    });

    expect(disputeStatus("disp_sub")).toBe("WON");
    expect(
      holds.consultant.map((e) => [e.status, e.refundedShareAmount]),
    ).toEqual(Array(4).fill(["PENDING", 0]));
    expect(holds.holds.every((h) => h.releasedAt !== null)).toBe(true);
    expect(mockPostLedgerTxn).not.toHaveBeenCalled();
    expect(mockApplyReversal).not.toHaveBeenCalled();
    expect(mockMintConsumerCreditNote).not.toHaveBeenCalled();
    expect(errorEvents()).toHaveLength(1);
    expect(errorEvents()[0].context).toMatchObject({
      disputeId: "disp_sub",
      paymentId: "pay_sub",
      storedStatus: "WON",
      incomingStatus: "lost",
      phase: "chargeback",
    });
  });

  test("a created event in phase pre_arbitration on a won dispute writes the event", async () => {
    seedSubscription();
    await deliver("payment.dispute.created", {
      ...SUB,
      status: "open",
      phase: "chargeback",
    });
    await deliver("payment.dispute.won", {
      ...SUB,
      status: "won",
      phase: "chargeback",
    });

    await deliver("payment.dispute.created", {
      ...SUB,
      status: "open",
      phase: "pre_arbitration",
    });

    expect(world.disputes).toHaveLength(1);
    expect(disputeStatus("disp_sub")).toBe("WON");
    expect(holds.consultant.every((e) => e.status === "PENDING")).toBe(true);
    expect(errorEvents()).toHaveLength(1);
    expect(errorEvents()[0].context).toMatchObject({
      disputeId: "disp_sub",
      paymentId: "pay_sub",
      storedStatus: "WON",
      incomingStatus: "open",
      phase: "pre_arbitration",
    });
  });

  test.each([
    [undefined, 0],
    ["chargeback", 0],
    ["pre_arbitration", 1],
  ])(
    "a redelivered won in phase %s writes %i events",
    async (phase, expected) => {
      seedSubscription();
      await deliver("payment.dispute.created", {
        ...SUB,
        status: "open",
        phase: "chargeback",
      });
      await deliver("payment.dispute.won", {
        ...SUB,
        status: "won",
        phase: "chargeback",
      });

      await deliver("payment.dispute.won", { ...SUB, status: "won", phase });

      expect(disputeStatus("disp_sub")).toBe("WON");
      expect(errorEvents()).toHaveLength(expected);
    },
  );
});

// ---------------------------------------------------------------------------
// Entry 2: a LOST that reports nothing deducted settles on the disputed amount.
// ---------------------------------------------------------------------------

describe("the amount a lost dispute settles on, through each caller", () => {
  const TRIAL = {
    id: "disp_trial",
    payment_id: "pay_gw_pay_trial",
    amount: 11_300,
  };

  /** Opens the dispute by webhook, then delivers the verdict by the webhook or the poll. */
  async function verdict(
    caller: "webhook" | "poll",
    status: "lost" | "closed",
    amountDeducted: number | null,
  ): Promise<void> {
    await deliver("payment.dispute.created", {
      ...TRIAL,
      status: "open",
      phase: "chargeback",
    });
    if (caller === "webhook") {
      await deliver(`payment.dispute.${status}`, {
        ...TRIAL,
        status,
        phase: "chargeback",
        amount_deducted: amountDeducted,
      });
      return;
    }
    mockGetRazorpayDispute.mockResolvedValue({
      disputeId: TRIAL.id,
      status,
      evidence: {},
      isChargeRefundable: false,
      dueBy: undefined,
      paymentId: TRIAL.payment_id,
      amountDeductedPaise: amountDeducted,
    });
    const run = await reconcileDisputes();
    expect(run).toMatchObject({ reconciledCount: 1, errors: [] });
  }

  function settledOn(): {
    share: [string, number] | undefined;
    clawbacks: number[];
    journals: string[];
    creditNotes: number[];
  } {
    const row = ce("ce_trial");
    return {
      share: row && [row.status, row.refundedShareAmount],
      clawbacks: mockApplyReversal.mock.calls.map(
        (c) => (c[1] as { amountPaise: number }).amountPaise,
      ),
      journals: mockPostLedgerTxn.mock.calls.map(
        (c) => (c[1] as { idempotencyKey: string }).idempotencyKey,
      ),
      creditNotes: mockMintConsumerCreditNote.mock.calls.map(
        (c) => (c[1] as { amountPaise: number }).amountPaise,
      ),
    };
  }

  const FULL_LOSS = {
    share: ["REFUNDED", 9_040],
    clawbacks: [9_040],
    journals: ["chargeback:disp_trial"],
    creditNotes: [11_300],
  };

  test.each(["webhook", "poll"] as const)(
    "%s: LOST with 0 deducted reverses the paid share, books a clawback and a credit note",
    async (caller) => {
      seedPaidTrial();
      await verdict(caller, "lost", 0);

      expect(disputeStatus("disp_trial")).toBe("LOST");
      expect(settledOn()).toEqual(FULL_LOSS);
      expect(infoEvents()).toHaveLength(1);
      expect(infoEvents()[0]).toMatchObject({
        via: "tx",
        context: expect.objectContaining({
          disputeId: "disp_trial",
          paymentId: "pay_trial",
          reportedDeductedPaise: 0,
          disputedPaise: 11_300,
          settledPaise: 11_300,
        }),
      });
    },
  );

  test.each(["webhook", "poll"] as const)(
    "%s: LOST with no figure settles on the disputed amount and records nothing",
    async (caller) => {
      seedPaidTrial();
      await verdict(caller, "lost", null);

      expect(settledOn()).toEqual(FULL_LOSS);
      expect(infoEvents()).toHaveLength(0);
    },
  );

  test.each(["webhook", "poll"] as const)(
    "%s: LOST with a smaller figure settles on it and records the difference",
    async (caller) => {
      seedPaidTrial();
      await verdict(caller, "lost", 5_000);

      expect(settledOn()).toEqual({
        share: ["PAID", 4_000], // floor(9040 × 5000 / 11300)
        clawbacks: [4_000],
        journals: ["chargeback:disp_trial"],
        creditNotes: [5_000],
      });
      expect(infoEvents()).toHaveLength(1);
      expect(infoEvents()[0].context).toMatchObject({
        reportedDeductedPaise: 5_000,
        disputedPaise: 11_300,
        settledPaise: 5_000,
      });
    },
  );

  test.each([
    [
      "webhook",
      0,
      { share: ["PAID", 0], clawbacks: [], journals: [], creditNotes: [] },
    ],
    [
      "poll",
      0,
      { share: ["PAID", 0], clawbacks: [], journals: [], creditNotes: [] },
    ],
    ["webhook", 11_300, FULL_LOSS],
    ["poll", 11_300, FULL_LOSS],
  ] as const)(
    "%s: CLOSED with %i deducted keeps its rule",
    async (caller, deducted, expected) => {
      seedPaidTrial();
      await verdict(caller, "closed", deducted);

      expect(disputeStatus("disp_trial")).toBe("CLOSED");
      expect(settledOn()).toEqual(expected);
      expect(infoEvents()).toHaveLength(0);
    },
  );
});
