/**
 * @jest-environment node
 */

/**
 * Unified reversal engine dispatch (#776 §C / ARCH #4). Asserts the front door
 * routes each source kind correctly. The deep booking cascade is mocked; it's
 * tested in its own suite.
 */

import {
  applyReversal,
  clawBackCompletedOrgPayout,
} from "@/lib/payments/operations/reversal-engine";
import { applyRefundCascade } from "../../lib/payments/operations/refund";

jest.mock("@/lib/payments/payouts/clawback-notifications", () => ({
  stageClawbackNotice: jest.fn(),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  applyRefundCascade: jest.fn().mockResolvedValue({
    legsReversed: 1,
    consultantEarningsReversed: 1,
    organizationEarningsReversed: 0,
    clawbackInitiated: false,
  }),
}));
// #1583 C-P1-09 — the clawback's ledger posting, rejectable per test.
const mockPostLedgerTxn = jest.fn();
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (...a: unknown[]) => mockPostLedgerTxn(...a),
}));
jest.mock("../../lib/enterprise/system-events", () => {
  const recordSystemError = jest.fn().mockResolvedValue(undefined);
  return {
    recordSystemError,
    recordSystemErrorSafe: recordSystemError,
  };
});
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

const mockedCascade = applyRefundCascade as jest.MockedFunction<
  typeof applyRefundCascade
>;

beforeEach(() => mockedCascade.mockClear());

describe("applyReversal — BOOKING", () => {
  it("delegates to applyRefundCascade with the payment id", async () => {
    const tx = {} as never;
    const res = await applyReversal(tx, {
      source: { kind: "BOOKING", paymentId: "pay-1" },
      amountPaise: 5000,
      reason: "test",
      refundId: "ref-1",
    });
    expect(res.kind).toBe("BOOKING");
    expect(res.cascades).toHaveLength(1);
    expect(mockedCascade).toHaveBeenCalledTimes(1);
    expect(mockedCascade).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ paymentId: "pay-1", amountPaise: 5000 }),
    );
  });
});

// #1583 C-P1-09 — the clawback's counter-post was reported and swallowed, so a
// payout could be stamped clawed-back with no journal behind it. The failure
// now propagates and the enclosing refund transaction rolls back with it.
describe("applyReversal — PAYOUT_CLAWBACK", () => {
  it("propagates a rejected ledger posting instead of committing an unbalanced journal", async () => {
    const tx = {
      organizationPayout: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "payout-1", clawbackInitiatedAt: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
      tDSRecord: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    mockPostLedgerTxn.mockRejectedValueOnce(new Error("journal unbalanced"));

    await expect(
      applyReversal(tx as never, {
        source: {
          kind: "PAYOUT_CLAWBACK",
          orgPayoutId: "payout-1",
          organizationId: "org-1",
          orgEarningsId: "oe-1",
        },
        amountPaise: 50_000,
        reason: "dispute lost",
        refundId: "refund-1",
      }),
    ).rejects.toThrow("journal unbalanced");
  });

  it("books the clawback as a receivable from the host org, never as cash", async () => {
    const tx = {
      organizationPayout: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "payout-1", clawbackInitiatedAt: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
      tDSRecord: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    mockPostLedgerTxn.mockResolvedValueOnce({
      transactionId: "txn",
      created: true,
    });

    await applyReversal(tx as never, {
      source: {
        kind: "PAYOUT_CLAWBACK",
        orgPayoutId: "payout-1",
        organizationId: "org-1",
        orgEarningsId: "oe-1",
      },
      amountPaise: 100_000,
      reason: "dispute lost",
      refundId: "dispute:d-1",
    });

    expect(mockPostLedgerTxn).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        idempotencyKey: "clawback:dispute:d-1:payout-1:oe-1",
        postings: [
          {
            account: { kind: "ORG_RECEIVABLE", organizationId: "org-1" },
            direction: "DEBIT",
            amountPaise: 100_000,
          },
          {
            account: { kind: "ORG_PAYABLE", organizationId: "org-1" },
            direction: "CREDIT",
            amountPaise: 100_000,
          },
        ],
      }),
    );
  });

  it("reverses the payout's TDS on the share and claws back only the net", async () => {
    // P1: net 100,000 withheld 100; the whole share is charged back.
    const created: Record<string, unknown>[] = [];
    const tx = {
      organizationPayout: {
        findUnique: jest.fn().mockResolvedValue({
          id: "payout-1",
          clawbackInitiatedAt: null,
          netPayoutPaise: 100_000,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
      tDSRecord: {
        findFirst: jest.fn().mockResolvedValue({
          id: "tds-1",
          financialYear: "2026-27",
          quarter: 3,
          tdsDeducted: 100,
          tdsRateBps: 10,
          tdsSection: "194O",
          cumulativeAmountCredited: 100_000,
          reportedInForm26Q: false,
        }),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: "tds-rev-1", ...data };
        }),
      },
      tdsAdjustment: { create: jest.fn().mockResolvedValue({}) },
    };
    mockPostLedgerTxn.mockResolvedValueOnce({
      transactionId: "txn",
      created: true,
    });

    await applyReversal(tx as never, {
      source: {
        kind: "PAYOUT_CLAWBACK",
        orgPayoutId: "payout-1",
        organizationId: "org-1",
        orgEarningsId: "oe-1",
      },
      amountPaise: 100_000,
      reason: "dispute lost",
      refundId: "dispute:d-1",
    });

    expect(created).toEqual([
      expect.objectContaining({
        organizationId: "org-1",
        orgPayoutId: "payout-1",
        tdsDeducted: -100,
        isReversal: true,
      }),
    ]);
    expect(tx.organizationPayout.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clawbackAmountPaise: { increment: 99_900 },
        }),
      }),
    );
    const [, journal] = mockPostLedgerTxn.mock.calls.at(-1) as [
      unknown,
      { postings: { amountPaise: number }[] },
    ];
    expect(journal.postings.map((p) => p.amountPaise)).toEqual([
      99_900, 99_900,
    ]);
  });

  it("journals every share one refund claws back from the same payout", async () => {
    // Two co-host shares of 50,000 sit on payout-1; one refund reverses both.
    const keys = new Set<string>();
    let journaledPaise = 0;
    mockPostLedgerTxn.mockImplementation(
      async (
        _tx: unknown,
        txn: { idempotencyKey: string; postings: { amountPaise: number }[] },
      ) => {
        if (keys.has(txn.idempotencyKey)) return { created: false };
        keys.add(txn.idempotencyKey);
        journaledPaise += txn.postings[0].amountPaise;
        return { created: true };
      },
    );
    const tx = {
      organizationPayout: { update: jest.fn().mockResolvedValue({}) },
      orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
      tDSRecord: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    for (const orgEarningsId of ["oe-a", "oe-b"]) {
      await clawBackCompletedOrgPayout(tx as never, {
        orgPayout: {
          id: "payout-1",
          netPayoutPaise: 100_000,
          clawbackInitiatedAt: null,
        },
        organizationId: "org-1",
        orgEarningsId,
        paymentId: "pay-1",
        refundId: "refund-1",
        grossPaise: 50_000,
        amountPaise: 100_000,
        label: "Refund clawback initiated",
        initiatedByUserId: null,
      });
    }
    // The counter rose by both shares, so the receivable must hold both too.
    expect(tx.organizationPayout.update).toHaveBeenCalledTimes(2);
    expect(journaledPaise).toBe(100_000);
    mockPostLedgerTxn.mockReset();
  });
});
