/**
 * A sold webinar or class is re-timed, never re-planned.
 *
 * Manage timings used to replace a live group event's sessions through the
 * allocator, moving paid attendees with no notice and no free leave. The
 * allocator now counts live seats under the event's advisory lock and refuses
 * with 409 `USE_RETIME`; a 1:1 booking and an unsold event pass through.
 */

import "./setup";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

import { assertGroupEventUnsoldInTx } from "@/lib/booking/allocation/guards";
import { AllocationConflictError } from "@/utils/scheduling-engine/errors";
import type { Tx } from "@/lib/prisma";

function txWithSeats(liveSeats: number) {
  const count = jest.fn().mockResolvedValue(liveSeats);
  const tx = { appointmentParticipant: { count } } as unknown as Tx;
  return { tx, count };
}

describe("assertGroupEventUnsoldInTx", () => {
  it.each(["webinar", "class"] as const)(
    "refuses a %s with a live seat as USE_RETIME",
    async (eventType) => {
      const { tx, count } = txWithSeats(2);
      const refusal = assertGroupEventUnsoldInTx(tx, eventType, "event-1");
      await expect(refusal).rejects.toBeInstanceOf(AllocationConflictError);
      await expect(refusal).rejects.toMatchObject({
        errorCode: "USE_RETIME",
        httpStatus: 409,
      });
      // Counts only live seats on this event's live appointment.
      expect(count).toHaveBeenCalledWith({
        where: {
          status: { in: ["HELD", "CONFIRMED", "ATTENDED"] },
          role: "CONSULTEE",
          appointment: { [`${eventType}Id`]: "event-1", deletedAt: null },
        },
      });
    },
  );

  it("lets an unsold group event be re-planned", async () => {
    const { tx } = txWithSeats(0);
    await expect(
      assertGroupEventUnsoldInTx(tx, "class", "event-1"),
    ).resolves.toBeUndefined();
  });

  it.each(["consultation", "subscription"] as const)(
    "never reads seats for a %s",
    async (eventType) => {
      const { tx, count } = txWithSeats(5);
      await expect(
        assertGroupEventUnsoldInTx(tx, eventType, "event-1"),
      ).resolves.toBeUndefined();
      expect(count).not.toHaveBeenCalled();
    },
  );
});
