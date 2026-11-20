/**
 * @jest-environment node
 */

/** A unique key a concurrent write took first answers the organiser a typed 409, never a raw fault. */
import { Prisma } from "@prisma/client";

const mockTransaction = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findFirst: async () => ({
        webinar: { webinarPlan: { title: "Intro to Python" } },
        class: null,
      }),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));
jest.mock("../../utils/appointmentlock", () => ({
  ...jest.requireActual("../../utils/appointmentlock"),
  withAppointmentLock: (_id: string, fn: (lock: unknown) => unknown) => fn({}),
  renewAppointmentLock: async () => undefined,
}));

import { removeAttendeeForConduct } from "@/lib/booking/conduct-removal";

it("answers REMOVAL_CONFLICT when the removal's transaction hits a unique key", async () => {
  mockTransaction.mockRejectedValue(
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["referenceNumber"] },
    }),
  );
  await expect(
    removeAttendeeForConduct({
      appointmentId: "appt-1",
      targetUserId: "learner-1",
      actorUserId: "host-1",
      reason: "HARASSMENT",
      note: null,
      authorizeTx: async () => true,
    }),
  ).rejects.toMatchObject({
    name: "BookingRuleError",
    code: "REMOVAL_CONFLICT",
    httpStatus: 409,
  });
});
