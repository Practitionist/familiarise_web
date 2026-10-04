/**
 * @jest-environment node
 */

// A refund of a parked capture returns only the cash from UNAPPLIED_RECEIPTS;
// a booked payment keeps the full fee/GST/earnings reversal, and a parked
// capture never accrues earnings.

const mockPostLedgerTxn = jest.fn();

jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (...a: unknown[]) => mockPostLedgerTxn(...a),
}));
jest.mock("../../lib/api/organizations/program-helpers", () => ({
  reverseBookingUtilization: jest.fn(),
}));
jest.mock("../../lib/payments/tax/tds-service", () => ({
  recordTdsReversal: jest.fn(),
}));
jest.mock("../../lib/api/organizations/wallet", () => ({
  walletCredit: jest.fn(),
}));
jest.mock("../../lib/payments/billing/overage-transitions", () => ({
  transitionOverage: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn().mockResolvedValue(0),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEventSafe: jest.fn(),
  recordSystemErrorSafe: jest.fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import type { Posting } from "../../lib/payments/ledger/post";
import { applyRefundCascade } from "../../lib/payments/operations/refund";
import {
  createEarningsFromPayment,
  ParkedCaptureEarningsError,
  type CreateEarningsParams,
} from "../../lib/payments/payouts/earnings-service";

const AMOUNT = 118_000;
const TAX = 18_000;

function txStub(payment: Record<string, unknown>, parked: boolean) {
  return {
    refund: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    payment: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(payment),
      findUnique: jest.fn().mockResolvedValue(payment),
    },
    consultantEarnings: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    organizationInvoice: { findUnique: jest.fn().mockResolvedValue(null) },
    creditNote: { findUnique: jest.fn().mockResolvedValue(null) },
    consumerCreditNote: { findUnique: jest.fn().mockResolvedValue(null) },
    consumerInvoice: { findUnique: jest.fn().mockResolvedValue(null) },
    overageEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    ledgerTransaction: {
      findUnique: jest.fn(
        async (args: { where: { idempotencyKey: string } }) =>
          parked && args.where.idempotencyKey === "unapplied:pay-1"
            ? { id: "txn-u" }
            : null,
      ),
    },
  };
}

type TxStub = ReturnType<typeof txStub>;

/** A hand-rolled stub cannot satisfy the full `Tx` type; cast once at the boundary. */
const asTx = (tx: TxStub) =>
  tx as unknown as Parameters<typeof applyRefundCascade>[0];

function cardPayment(earnings: unknown[]) {
  return {
    id: "pay-1",
    appointmentId: "appt-1",
    amount: AMOUNT,
    originalAmount: AMOUNT - TAX,
    taxAmount: TAX,
    organizationId: null,
    billingAccountId: null,
    billableToOrgInvoiceId: null,
    parentPaymentId: null,
    legs: [{ id: "leg-1", source: "CARD", amountPaise: AMOUNT }],
    earnings,
    organizationEarnings: [],
    bookingUtilization: null,
    refunds: [],
    disputes: [],
  };
}

const postings = (): Posting[] => mockPostLedgerTxn.mock.calls[0][1].postings;

beforeEach(() => {
  jest.clearAllMocks();
  mockPostLedgerTxn.mockResolvedValue({ transactionId: "t", created: true });
});

it("a partial refund of a parked capture debits UNAPPLIED_RECEIPTS and credits CASH only", async () => {
  const tx = txStub(cardPayment([]), true);
  await applyRefundCascade(asTx(tx), {
    paymentId: "pay-1",
    refundId: "ref-1",
    amountPaise: 50_000,
    reason: "auto-refund",
  });

  expect(mockPostLedgerTxn).toHaveBeenCalledTimes(1);
  expect(mockPostLedgerTxn.mock.calls[0][1]).toMatchObject({
    idempotencyKey: "refund:ref-1",
    kind: "REFUND",
  });
  expect(postings()).toEqual([
    {
      account: { kind: "UNAPPLIED_RECEIPTS" },
      direction: "DEBIT",
      amountPaise: 50_000,
    },
    { account: { kind: "CASH" }, direction: "CREDIT", amountPaise: 50_000 },
  ]);
  expect(tx.consumerInvoice.findUnique).not.toHaveBeenCalled();
});

it("a booked payment keeps the fee, GST and payable reversal and never reads the clearing key", async () => {
  const tx = txStub(
    cardPayment([
      {
        id: "earn-1",
        consultantProfileId: "cp-1",
        consultantSharePaise: 80_000,
        refundedShareAmount: 0,
        status: "PENDING",
        payoutId: null,
      },
    ]),
    false,
  );
  await applyRefundCascade(asTx(tx), {
    paymentId: "pay-1",
    refundId: "ref-2",
    amountPaise: AMOUNT,
    reason: "cancellation",
  });

  const kinds = postings().map((p) => `${p.direction}:${p.account.kind}`);
  expect(kinds).toEqual(
    expect.arrayContaining([
      "CREDIT:CASH",
      "DEBIT:GST_PAYABLE",
      "DEBIT:CONSULTANT_PAYABLE",
      "DEBIT:PLATFORM_FEE",
    ]),
  );
  expect(kinds.some((k) => k.endsWith("UNAPPLIED_RECEIPTS"))).toBe(false);
  expect(tx.ledgerTransaction.findUnique).not.toHaveBeenCalled();
});

it("createEarningsFromPayment refuses a parked capture before writing anything", async () => {
  const tx = txStub(cardPayment([]), true);
  const payment = {
    ...cardPayment([]),
    appointmentId: null,
    userId: "user-1",
    createdAt: new Date(),
    appointment: { consultantProfile: { id: "cp-1" } },
  } as unknown as CreateEarningsParams["payment"];

  await expect(
    createEarningsFromPayment({
      payment,
      appointmentType: "CONSULTATION",
      tx: asTx(tx),
    }),
  ).rejects.toBeInstanceOf(ParkedCaptureEarningsError);
  expect(mockPostLedgerTxn).not.toHaveBeenCalled();
});
