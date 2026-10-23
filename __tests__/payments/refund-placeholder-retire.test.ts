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
});
