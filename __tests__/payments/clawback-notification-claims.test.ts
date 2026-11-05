/** @jest-environment node */
const mockStage = jest.fn(async (..._args: unknown[]) => undefined);
const mockPost = jest.fn(async (..._args: unknown[]) => ({
  transactionId: "journal",
  created: true,
}));
jest.mock("@/lib/payments/payouts/clawback-notifications", () => ({
  stageClawbackNotice: (...args: unknown[]) => mockStage(...args),
}));
jest.mock("@/lib/payments/ledger/post", () => ({
  ...jest.requireActual<typeof import("@/lib/payments/ledger/post")>(
    "@/lib/payments/ledger/post",
  ),
  postLedgerTxn: (...args: unknown[]) => mockPost(...args),
  ledgerBalancePaise: jest.fn(async () => 20000),
}));
jest.mock("@/lib/payments/operations/refund", () => ({
  applyRefundCascade: jest.fn(),
}));
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
import { txDouble } from "../fixtures/tx-double";
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

beforeEach(() => {
  jest.clearAllMocks();
  mockPost.mockResolvedValue({ transactionId: "journal", created: true });
});
const payee = { rail: "CONSULTANT", consultantProfileId: "expert" } as const;
const clawback = {
  refundId: "refund",
  consultantPayoutId: "payout",
  consultantProfileId: "expert",
  amountPaise: 15000,
  reason: "refund",
};

it.each([postRefundClawback, postDisputeClawback])(
  "stages a raised notice only for a new consultant journal",
  async (post) => {
    const tx = txDouble({});
    await post(tx, clawback);
    expect(mockStage).toHaveBeenCalledWith(tx, {
      payee,
      payoutId: "payout",
      journalId: "journal",
      event: "RAISED",
      amountPaise: 15000,
    });
    mockStage.mockClear();
    mockPost.mockResolvedValueOnce({
      transactionId: "journal",
      created: false,
    });
    await post(tx, clawback);
    expect(mockStage).not.toHaveBeenCalled();
  },
);

it("stages the organisation share using the returned journal identity", async () => {
  const tx = txDouble({});
  await postPayoutClawback(tx, {
    refundId: "refund",
    payoutId: "payout",
    orgEarningsId: "share",
    amountPaise: 5000,
    organizationId: "org",
  });
  expect(mockStage).toHaveBeenCalledWith(tx, {
    payee: { rail: "ORG", organizationId: "org" },
    payoutId: "payout",
    journalId: "journal",
    event: "RAISED",
    amountPaise: 5000,
  });
});

it("stages the existing computed recovery as reserved rather than paid", async () => {
  const tx = txDouble({});
  expect(
    await recoverClawbackOnPayout(tx, {
      payee,
      payoutId: "next",
      recoverablePaise: 7000,
    }),
  ).toBe(7000);
  expect(mockStage).toHaveBeenCalledWith(tx, {
    payee,
    payoutId: "next",
    journalId: "journal",
    event: "OFFSET_RESERVED",
    amountPaise: 7000,
  });
});

const entries = [
  {
    direction: "DEBIT",
    amountPaise: 5000,
    account: {
      kind: "CONSULTANT_PAYABLE",
      consultantProfileId: "expert",
      organizationId: null,
    },
  },
  {
    direction: "CREDIT",
    amountPaise: 5000,
    account: {
      kind: "CONSULTANT_RECEIVABLE",
      consultantProfileId: "expert",
      organizationId: null,
    },
  },
];
it("stages a released offset only when the release journal is newly posted", async () => {
  const tx = txDouble({
    ledgerTransaction: {
      findMany: jest.fn(async () => [
        { idempotencyKey: "clawback-recovery:next", kind: "PAYOUT", entries },
      ]),
    },
  });
  await releaseClawbackRecovery(tx, "next");
  expect(mockStage).toHaveBeenCalledWith(tx, {
    payee,
    payoutId: "next",
    journalId: "journal",
    event: "OFFSET_RELEASED",
    amountPaise: 5000,
  });
  mockStage.mockClear();
  mockPost.mockResolvedValueOnce({ transactionId: "journal", created: false });
  await releaseClawbackRecovery(tx, "next");
  expect(mockStage).not.toHaveBeenCalled();
});

it("stages only the void amount the ledger calculation selected", async () => {
  const tx = txDouble({
    ledgerTransaction: {
      findMany: jest.fn(async () => [
        {
          id: "origin",
          idempotencyKey: "clawback:refund:payout",
          kind: "PAYOUT",
          entries,
        },
      ]),
    },
    ledgerEntry: {
      findMany: jest.fn(async () => [
        { transactionId: "origin", amountPaise: 5000 },
      ]),
    },
  });
  expect(
    await voidClawbacksRaisedOnPayout(tx, {
      payoutId: "payout",
      consultantProfileId: "expert",
    }),
  ).toEqual({ voidedPaise: 5000, alreadyRecoveredPaise: 0 });
  expect(mockStage).toHaveBeenCalledWith(tx, {
    payee,
    payoutId: "payout",
    journalId: "journal",
    event: "VOIDED",
    amountPaise: 5000,
  });
});

it("propagates staging failures so the journal and notice cannot commit separately", async () => {
  mockStage.mockRejectedValueOnce(new Error("staging unavailable"));
  await expect(postRefundClawback(txDouble({}), clawback)).rejects.toThrow(
    "staging unavailable",
  );
});
