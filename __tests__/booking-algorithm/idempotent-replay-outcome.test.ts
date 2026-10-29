/**
 * An idempotent replay reports where the approval landed: a replay of an
 * approval still awaiting payment says so, so the route re-attempts the
 * (idempotent) pay-link mint instead of telling the expert the times are
 * confirmed.
 */

import "./setup";

import { findIdempotentAllocation } from "@/lib/booking/allocation/idempotency";
import type { PrismaLike } from "@/lib/prisma";

function dbWith(status: string): PrismaLike {
  return {
    appointment: {
      findUnique: jest.fn().mockResolvedValue({
        id: "apt-1",
        consultationId: "c-1",
        subscriptionId: null,
        webinarId: null,
        classId: null,
      }),
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: "apt-1", deletedAt: null, occurrences: [] }]),
    },
    consultation: { findUnique: jest.fn().mockResolvedValue({ status }) },
  } as unknown as PrismaLike;
}

describe("findIdempotentAllocation — replay outcome", () => {
  it("replays an approval awaiting payment as awaiting_payment", async () => {
    const replay = await findIdempotentAllocation(
      "consultation",
      "c-1",
      "key-1",
      undefined,
      dbWith("APPROVED_PENDING_PAYMENT"),
    );
    expect(replay).toMatchObject({
      success: true,
      outcome: "awaiting_payment",
    });
  });

  it("replays a settled approval as approved", async () => {
    const replay = await findIdempotentAllocation(
      "consultation",
      "c-1",
      "key-1",
      undefined,
      dbWith("APPROVED"),
    );
    expect(replay?.outcome).toBe("approved");
  });
});
