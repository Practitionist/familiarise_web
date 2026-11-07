/** @jest-environment node */

// Clawback notices stage with the journal that caused them, once per new
// journal, and a broken template never rolls the clawback back.

const mockPost = jest.fn();
const mockBalance = jest.fn();
const mockStage = jest.fn();
jest.mock("@/lib/payments/ledger/post", () => ({
  ...jest.requireActual("@/lib/payments/ledger/post"),
  postLedgerTxn: (...args: unknown[]) => mockPost(...args),
  ledgerBalancePaise: (...args: unknown[]) => mockBalance(...args),
}));
jest.mock("@/lib/payments/payouts/clawback-notifications", () => {
  const actual = jest.requireActual(
    "@/lib/payments/payouts/clawback-notifications",
  );
  return {
    stageClawbackNotice: (...args: unknown[]) => {
      mockStage(...args);
      return actual.stageClawbackNotice(...args);
    },
    // Records the RAISED call it makes, so assertions see one staging shape.
    stageRaisedClawback: (
      db: unknown,
      posted: { created: boolean; transactionId: string },
      input: Record<string, unknown>,
    ) => {
      if (posted.created) {
        mockStage(db, {
          ...input,
          journalId: posted.transactionId,
          event: "RAISED",
        });
      }
      return actual.stageRaisedClawback(db, posted, input);
    },
  };
});
jest.mock("@/emails/payments/ClawbackNoticeEmail", () => ({
  ...jest.requireActual("@/emails/payments/ClawbackNoticeEmail"),
  ClawbackNoticeEmail: () => {
    throw new Error("clawback template boom");
  },
}));
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));

import * as Sentry from "@sentry/nextjs";
import { postConsultantPayoutClawback as postRefundClawback } from "@/lib/payments/payouts/paid-consultant-clawback";
import {
  postConsultantPayoutClawback as postDisputeClawback,
  postPayoutClawback,
} from "@/lib/payments/operations/reversal-engine";
import {
  recoverClawbackOnPayout,
  releaseClawbackRecovery,
  voidClawbacksRaisedOnPayout,
} from "@/lib/payments/payouts/clawback-recovery";

const bells: Record<string, unknown>[] = [];
const emails: Record<string, unknown>[] = [];
const people = [
  { id: "expert", email: "expert@example.com", name: "Expert" },
  { id: "owner", email: "owner@example.com", name: "Owner" },
  {
    id: "muted",
    email: "muted@example.com",
    name: "Muted",
    notificationPreferences: { inAppEnabled: false, orgBillingAlerts: false },
  },
];

function makeTx(extra: Record<string, unknown> = {}) {
  return {
    user: {
      findMany: jest.fn(async (q: { where: { id: { in: string[] } } }) =>
        people.filter((p) => q.where.id.in.includes(p.id)),
      ),
    },
    consultantProfile: {
      findUnique: jest.fn(async () => ({ userId: "expert" })),
    },
    membership: {
      findMany: jest.fn(async () => [{ userId: "owner" }, { userId: "muted" }]),
    },
    notificationOutbox: {
      upsert: jest.fn(async (q: { create: Record<string, unknown> }) => {
        bells.push(q.create);
        return { id: `bell_${bells.length}`, ...q.create };
      }),
    },
    failedEmail: {
      create: jest.fn(async (q: { data: Record<string, unknown> }) => {
        emails.push(q.data);
        return { id: `fe_${emails.length}` };
      }),
    },
    emailSuppression: { findUnique: jest.fn(async () => null) },
    ...extra,
  } as never;
}

const consultantClawback = {
  refundId: "refund",
  consultantPayoutId: "payout",
  consultantProfileId: "profile",
  amountPaise: 15_000,
  reason: "refund",
};

beforeEach(() => {
  jest.clearAllMocks();
  bells.length = 0;
  emails.length = 0;
  process.env.EMAIL_DELIVERY_MODE = "live";
  mockPost.mockResolvedValue({ transactionId: "journal", created: true });
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it.each([
  ["refund", postRefundClawback],
  ["dispute", postDisputeClawback],
])(
  "%s clawback: a throwing template still commits the journal, rings the payee once and leaves a render_failed trace",
  async (_door, post) => {
    const tx = makeTx();
    await expect(post(tx, consultantClawback)).resolves.toBeUndefined();

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(bells).toEqual([
      expect.objectContaining({
        workflowId: "payout-clawback",
        recipients: ["expert"],
        payload: expect.objectContaining({
          eventKind: "RAISED",
          amount: "₹150.00",
        }),
      }),
    ]);
    expect(emails).toEqual([
      expect.objectContaining({
        emailType: "PAYOUT_CLAWBACK",
        recipient: "expert@example.com",
        status: "DEAD_LETTER",
        lastError: "review:render_failed",
        entityRef: "clawback:journal",
      }),
    ]);
    expect(Sentry.captureException).not.toHaveBeenCalled();

    // A replayed refund finds the journal already posted: no second notice.
    mockPost.mockResolvedValueOnce({
      transactionId: "journal",
      created: false,
    });
    await post(tx, consultantClawback);
    expect(bells).toHaveLength(1);
    expect(emails).toHaveLength(1);
  },
);

it("org clawback: the visibility roster is rung inside the transaction and the policy drops a muted member", async () => {
  const tx = makeTx();
  await postPayoutClawback(tx, {
    refundId: "refund",
    payoutId: "org-payout",
    orgEarningsId: "share",
    amountPaise: 5_000,
    organizationId: "org",
  });
  expect(bells).toEqual([
    expect.objectContaining({
      workflowId: "org-payout-clawback",
      recipients: ["owner"],
    }),
  ]);
  // Email follows its own switch: the muted member opted out of org billing.
  expect(emails.map((e) => e.recipient)).toEqual(["owner@example.com"]);
  expect(mockStage).toHaveBeenCalledWith(tx, expect.anything());
});

it("recovery and release ring the payee as bells only, once per new journal", async () => {
  const side = (direction: string, kind: string, paise: number) => ({
    direction,
    amountPaise: paise,
    account: { kind, consultantProfileId: "profile", organizationId: null },
  });
  const tx = makeTx({
    ledgerTransaction: {
      findMany: jest.fn(async () => [
        {
          idempotencyKey: "clawback-recovery:next",
          kind: "PAYOUT",
          entries: [
            side("DEBIT", "CONSULTANT_PAYABLE", 7_000),
            side("CREDIT", "CONSULTANT_RECEIVABLE", 7_000),
          ],
        },
      ]),
    },
  });
  mockBalance.mockResolvedValue(20_000);
  const payee = { rail: "CONSULTANT", consultantProfileId: "profile" } as const;

  await recoverClawbackOnPayout(tx, {
    payee,
    payoutId: "next",
    recoverablePaise: 7_000,
  });
  await releaseClawbackRecovery(tx, "next");
  mockPost.mockResolvedValue({ transactionId: "journal", created: false });
  await recoverClawbackOnPayout(tx, {
    payee,
    payoutId: "next",
    recoverablePaise: 7_000,
  });
  await releaseClawbackRecovery(tx, "next");

  expect(bells.map((b) => b.payload)).toEqual([
    expect.objectContaining({ eventKind: "OFFSET_RESERVED", amount: "₹70.00" }),
    expect.objectContaining({ eventKind: "OFFSET_RELEASED", amount: "₹70.00" }),
  ]);
  expect(emails).toEqual([]);
});

it("a bank-returned payout voiding two debts rings one VOIDED bell and never a raised notice", async () => {
  const entries = (paise: number) => [
    {
      direction: "DEBIT",
      amountPaise: paise,
      account: {
        kind: "CONSULTANT_RECEIVABLE",
        consultantProfileId: "profile",
        organizationId: null,
      },
    },
    {
      direction: "CREDIT",
      amountPaise: paise,
      account: {
        kind: "CONSULTANT_PAYABLE",
        consultantProfileId: "profile",
        organizationId: null,
      },
    },
  ];
  const tx = makeTx({
    ledgerTransaction: {
      findMany: jest.fn(async () => [
        {
          id: "a",
          idempotencyKey: "clawback:r1:payout",
          kind: "PAYOUT",
          entries: entries(3_000),
        },
        {
          id: "b",
          idempotencyKey: "clawback:r2:payout",
          kind: "PAYOUT",
          entries: entries(2_000),
        },
      ]),
    },
    ledgerEntry: {
      findMany: jest.fn(async () => [
        { transactionId: "a", amountPaise: 3_000 },
        { transactionId: "b", amountPaise: 2_000 },
      ]),
    },
  });
  mockPost
    .mockResolvedValueOnce({ transactionId: "void-a", created: true })
    .mockResolvedValueOnce({ transactionId: "void-b", created: true });
  mockBalance.mockResolvedValue(5_000);

  await voidClawbacksRaisedOnPayout(tx, {
    payoutId: "payout",
    consultantProfileId: "profile",
  });

  expect(bells).toEqual([
    expect.objectContaining({
      payload: expect.objectContaining({
        eventKind: "VOIDED",
        amount: "₹50.00",
      }),
    }),
  ]);
  expect(emails).toEqual([]);
});
