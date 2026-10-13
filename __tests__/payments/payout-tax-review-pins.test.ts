/**
 * @jest-environment node
 *
 * Pins for the payout and GST review round: the shared refund gate ignores
 * zero-amount credit restorations, a failed payout re-opens its clawback
 * recovery in the same transaction, and commercial credit notes stay out of
 * the GSTR-1 register.
 */
const mockPostLedgerTxn = jest.fn();
jest.mock("../../lib/payments/ledger/post", () => ({
  __esModule: true,
  postLedgerTxn: (...a: unknown[]) => mockPostLedgerTxn(...a),
  ledgerAccountId: jest.fn(),
  ledgerBalancePaise: jest.fn(),
}));

const mockCreditNoteFindMany = jest.fn();
const mockConsumerNoteFindMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findMany: jest.fn().mockResolvedValue([]) },
    consumerInvoice: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
    },
    organizationInvoice: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
    },
    consumerCreditNote: {
      findMany: (...a: unknown[]) => mockConsumerNoteFindMany(...a),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn(),
    },
    creditNote: {
      findMany: (...a: unknown[]) => mockCreditNoteFindMany(...a),
      count: jest.fn().mockResolvedValue(1),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _opts: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({
  mintConsumerInvoice: jest.fn(),
}));

import { RefundStatus } from "@prisma/client";
import { REFUND_GATED_PAYMENT_WHERE } from "@/lib/payments/payouts/shared-lifecycle";
import { releaseClawbackRecovery } from "@/lib/payments/payouts/clawback-recovery";
import { runGstOutwardRegisterExport } from "@/jobs/compliance/gst-outward-register-export";
import { txDouble } from "../fixtures/tx-double";

beforeEach(() => {
  jest.clearAllMocks();
  mockCreditNoteFindMany.mockResolvedValue([]);
  mockConsumerNoteFindMany.mockResolvedValue([]);
});

it("gates both payout rails on cash refunds only, never a credit restoration", () => {
  const some = REFUND_GATED_PAYMENT_WHERE.refunds.some;
  expect(some.amountPaise).toEqual({ gt: 0 });
  expect(some.status.notIn).toEqual([
    RefundStatus.FAILED,
    RefundStatus.CANCELLED,
  ]);
});

it("re-opens the recovery of a failed payout once, mirroring its journal", async () => {
  const recovery = {
    idempotencyKey: "clawback-recovery:po_1",
    kind: "ORG_PAYOUT",
    entries: [
      {
        direction: "DEBIT",
        amountPaise: BigInt(40_000),
        account: {
          kind: "ORG_PAYABLE",
          organizationId: "org_1",
          consultantProfileId: null,
        },
      },
      {
        direction: "CREDIT",
        amountPaise: BigInt(40_000),
        account: {
          kind: "CASH",
          organizationId: null,
          consultantProfileId: null,
        },
      },
    ],
  };
  const findMany = jest.fn().mockResolvedValueOnce([recovery]);
  const tx = txDouble({ ledgerTransaction: { findMany } });

  await releaseClawbackRecovery(tx, "po_1");

  expect(mockPostLedgerTxn).toHaveBeenCalledWith(tx, {
    idempotencyKey: "clawback-recovery-release:po_1",
    kind: "ORG_PAYOUT",
    payoutId: "po_1",
    description: expect.any(String),
    postings: [
      {
        account: {
          kind: "ORG_PAYABLE",
          organizationId: "org_1",
          consultantProfileId: null,
        },
        direction: "CREDIT",
        amountPaise: 40_000,
      },
      {
        account: {
          kind: "CASH",
          organizationId: null,
          consultantProfileId: null,
        },
        direction: "DEBIT",
        amountPaise: 40_000,
      },
    ],
  });

  // Already released: a second terminal move posts nothing.
  findMany.mockResolvedValueOnce([
    recovery,
    { ...recovery, idempotencyKey: "clawback-recovery-release:po_1" },
  ]);
  await releaseClawbackRecovery(tx, "po_1");
  expect(mockPostLedgerTxn).toHaveBeenCalledTimes(1);
});

it("keeps commercial credit notes out of the GSTR-1 register", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});

  await runGstOutwardRegisterExport({ writeCsv: false });

  for (const findMany of [mockCreditNoteFindMany, mockConsumerNoteFindMany]) {
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      isCommercial: false,
    });
  }
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("1 commercial credit note(s)"),
  );
});
