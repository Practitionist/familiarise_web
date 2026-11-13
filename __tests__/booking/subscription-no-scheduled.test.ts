/**
 * A subscription never enters SCHEDULED or APPROVED_PENDING_PAYMENT: the map gives
 * it no edge, and no caller's `fromIn` can widen it into SCHEDULED.
 */
import {
  REQUEST_ALLOWED_FROM,
  SUBSCRIPTION_ALLOWED_FROM,
  transitionConsultationRequest,
  transitionSubscriptionRequest,
} from "../../lib/booking/transitions";
import { IllegalTransitionError } from "../../lib/enterprise/transitions";

function makeTx(model: "subscription" | "consultation") {
  const updateMany = jest.fn(
    async (args: { where: { status: { in: string[] } } }) => ({
      count: args.where.status.in.length > 0 ? 1 : 0,
    }),
  );
  const tx = {
    [model]: {
      findUnique: jest.fn(async () => ({ status: "APPROVED" })),
      updateMany,
    },
    bookingStatusHistory: { create: jest.fn(async () => ({})) },
  };
  return { tx, updateMany };
}

describe("subscription status map", () => {
  it("has no SCHEDULED edge in or out", () => {
    expect(SUBSCRIPTION_ALLOWED_FROM.SCHEDULED).toEqual([]);
    for (const from of Object.values(SUBSCRIPTION_ALLOWED_FROM))
      expect(from).not.toContain("SCHEDULED");
  });

  it("completes from APPROVED and cancels from every live state", () => {
    expect(SUBSCRIPTION_ALLOWED_FROM.COMPLETED).toEqual(["APPROVED"]);
    expect(SUBSCRIPTION_ALLOWED_FROM.CANCELLED).toEqual([
      "PENDING",
      "APPROVED",
    ]);
  });

  it("never awaits payment: a plan is paid at checkout", () => {
    expect(SUBSCRIPTION_ALLOWED_FROM.APPROVED_PENDING_PAYMENT).toEqual([]);
    for (const from of Object.values(SUBSCRIPTION_ALLOWED_FROM))
      expect(from).not.toContain("APPROVED_PENDING_PAYMENT");
  });

  it("refuses SCHEDULED even when the caller widens fromIn", async () => {
    const { tx, updateMany } = makeTx("subscription");
    await expect(
      transitionSubscriptionRequest(tx as never, {
        where: { id: "s1" },
        to: "SCHEDULED",
        fromIn: ["APPROVED"],
      }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    expect(updateMany.mock.calls[0][0].where.status.in).toEqual([]);
  });

  it("keeps the consultation SCHEDULED edge", async () => {
    expect(REQUEST_ALLOWED_FROM.SCHEDULED).toEqual([
      "APPROVED",
      "APPROVED_PENDING_PAYMENT",
    ]);
    const { tx } = makeTx("consultation");
    await expect(
      transitionConsultationRequest(tx as never, {
        where: { id: "c1" },
        to: "SCHEDULED",
      }),
    ).resolves.toBeUndefined();
  });
});
