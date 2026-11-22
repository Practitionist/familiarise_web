/**
 * @jest-environment node
 */

const mockStampSeat = jest.fn(async (..._a: unknown[]) => 1);
jest.mock("@/lib/booking/participants", () => ({
  transitionParticipant: (...a: unknown[]) => mockStampSeat(...a),
}));
const mockIntentInTx = jest.fn(async (..._a: unknown[]) => new Date(0));
jest.mock("@/lib/stream/revocation-intents", () => ({
  persistRefundRevocationInTx: (...a: unknown[]) => mockIntentInTx(...a),
}));

import { retireSupersededPlaceholderTx } from "@/lib/payments/operations/refund-placeholder";
import type { Tx } from "@/lib/prisma";

function fakeTx(deleted: number, survivor: { id: string } | null) {
  return {
    refund: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ metadata: {} }),
      deleteMany: jest.fn().mockResolvedValue({ count: deleted }),
      findUnique: jest.fn().mockResolvedValue(survivor),
      update: jest.fn().mockResolvedValue({}),
    },
    supportFinancialRecommendation: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

const placeholder = { id: "ph-1", dedupeKey: null, metadata: null };

describe("retireSupersededPlaceholderTx", () => {
  it("deletes only a pending, uncascaded placeholder", async () => {
    const tx = fakeTx(1, null);
    await retireSupersededPlaceholderTx(
      tx as unknown as Tx,
      placeholder,
      "w-1",
    );
    expect(tx.refund.deleteMany).toHaveBeenCalledWith({
      where: { id: "ph-1", status: "PENDING", cascadedAt: null },
    });
    expect(tx.refund.update).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when a concurrent retirement already removed the placeholder", async () => {
    const tx = fakeTx(0, null);
    await retireSupersededPlaceholderTx(
      tx as unknown as Tx,
      placeholder,
      "w-1",
    );
    expect(tx.refund.update).not.toHaveBeenCalled();
  });

  it("refuses when the placeholder survives in another state", async () => {
    const tx = fakeTx(0, { id: "ph-1" });
    await expect(
      retireSupersededPlaceholderTx(tx as unknown as Tx, placeholder, "w-1"),
    ).rejects.toThrow(/refusing to retire/);
    expect(tx.refund.update).not.toHaveBeenCalled();
  });

  it("decides a SUCCEEDED winner's seat from the placeholder's intent, in the same transaction", async () => {
    const intent = {
      keepSeat: false,
      keepSeatIfPartial: false,
    };
    const tx = {
      ...fakeTx(1, null),
      refund: {
        ...fakeTx(1, null).refund,
        // The webhook settled the winner with no intent; the merge just gave it the placeholder's.
        findUnique: jest.fn().mockResolvedValue({
          status: "SUCCEEDED",
          paymentId: "pay-1",
          metadata: { seatIntent: intent },
          payment: {
            amount: 50_000,
            userId: "buyer-1",
            refunds: [{ amountPaise: 50_000, status: "SUCCEEDED" }],
            disputes: [],
          },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    await expect(
      retireSupersededPlaceholderTx(
        tx as unknown as Tx,
        { ...placeholder, metadata: { seatIntent: intent } },
        "w-1",
      ),
    ).resolves.toMatchObject({ seat: { endsSeat: true } });
    expect(tx.refund.updateMany).toHaveBeenCalledWith({
      where: { id: "w-1", status: "SUCCEEDED" },
      data: { metadata: { seatIntent: intent, endsSeat: true } },
    });
    expect(mockStampSeat).toHaveBeenCalledWith(
      tx,
      { paymentId: "pay-1" },
      "REFUNDED",
      expect.anything(),
    );
    expect(mockIntentInTx).toHaveBeenCalledWith(tx, {
      refundId: "w-1",
      payerUserId: "buyer-1",
    });
  });
});
