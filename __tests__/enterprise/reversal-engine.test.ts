/**
 * @jest-environment node
 */

/**
 * Unified reversal engine dispatch (#776 §C / ARCH #4). Asserts the front door
 * routes each source kind correctly. The deep booking cascade is mocked; it's
 * tested in its own suite.
 */

import { applyReversal } from "@/lib/payments/operations/reversal-engine";
import { applyRefundCascade } from "../../lib/payments/operations/refund";

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
    };
    mockPostLedgerTxn.mockRejectedValueOnce(new Error("journal unbalanced"));

    await expect(
      applyReversal(tx as never, {
        source: {
          kind: "PAYOUT_CLAWBACK",
          orgPayoutId: "payout-1",
          organizationId: "org-1",
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
    };
    mockPostLedgerTxn.mockResolvedValueOnce(undefined);

    await applyReversal(tx as never, {
      source: {
        kind: "PAYOUT_CLAWBACK",
        orgPayoutId: "payout-1",
        organizationId: "org-1",
      },
      amountPaise: 100_000,
      reason: "dispute lost",
      refundId: "dispute:d-1",
    });

    expect(mockPostLedgerTxn).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        idempotencyKey: "clawback:dispute:d-1:payout-1",
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
});
