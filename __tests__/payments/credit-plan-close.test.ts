/**
 * @jest-environment node
 */

/**
 * A credit plan's queued partial return can be answered "no credit owed":
 * nothing goes back, the tranches it left unheld start their hold, and the
 * queue row retires. A plan still running is refused.
 */
const stampTranchesOnCancel = jest.fn(async (..._a: unknown[]) => 2);
jest.mock("../../lib/booking/subscription-cycle", () => ({
  stampTranchesOnCancel: (...a: unknown[]) => stampTranchesOnCancel(...a),
}));
const recordSystemEvent = jest.fn(async (..._a: unknown[]) => {});
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: (...a: unknown[]) => recordSystemEvent(...a),
}));

import { closeCreditReturnWithoutCredit } from "@/lib/payments/operations/credit-plan-return";

const NOW = new Date("2026-06-01T00:00:00Z");

const txFor = (over: { status?: string; paymentIntent?: string } = {}) => ({
  payment: {
    findUnique: async () => ({
      paymentIntent: over.paymentIntent ?? "free_1730000000_sub",
      paymentStatus: "SUCCEEDED",
      appointment: {
        subscription: { id: "sub-1", status: over.status ?? "CANCELLED" },
      },
    }),
  },
});

beforeEach(() => jest.clearAllMocks());

it.each(["CANCELLED", "COMPLETED"])(
  "an ended (%s) plan holds its tranches and records the answer in the same commit",
  async (status) => {
    const tx = txFor({ status });
    const result = await closeCreditReturnWithoutCredit(tx as never, {
      paymentId: "pay-1",
      initiatedByUserId: "admin-1",
      reason: "two sessions delivered, nothing more owed",
      now: NOW,
    });
    expect(result).toEqual({ stamped: 2 });
    expect(stampTranchesOnCancel).toHaveBeenCalledWith(tx, {
      paymentId: "pay-1",
      now: NOW,
    });
    expect(recordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        db: tx,
        strict: true,
        correlationId: "partial-credit-closed:pay-1",
      }),
    );
  },
);

it("a plan still running is refused and nothing is stamped", async () => {
  await expect(
    closeCreditReturnWithoutCredit(txFor({ status: "APPROVED" }) as never, {
      paymentId: "pay-1",
      initiatedByUserId: "admin-1",
      reason: "too early",
    }),
  ).rejects.toMatchObject({ code: "PLAN_STILL_LIVE" });
  expect(stampTranchesOnCancel).not.toHaveBeenCalled();
  expect(recordSystemEvent).not.toHaveBeenCalled();
});

it("a cash-paid plan is not this door's", async () => {
  await expect(
    closeCreditReturnWithoutCredit(
      txFor({ paymentIntent: "order_abc" }) as never,
      {
        paymentId: "pay-1",
        initiatedByUserId: "admin-1",
        reason: "wrong door",
      },
    ),
  ).rejects.toMatchObject({ code: "NOT_CREDIT_FUNDED" });
  expect(stampTranchesOnCancel).not.toHaveBeenCalled();
});
