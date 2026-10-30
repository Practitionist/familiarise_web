/**
 * A booking with no session left gets its new time from the expert's manual
 * allocation grid: on an approved consultation the allocator places a fresh
 * session whether the old row is parked (RESCHEDULED) or cancelled.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";
import { halfHourStarts, publishEveryHour } from "./harness-host";

jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(async () => ({
    id: `order_${randomUUID()}`,
    client_secret: null,
  })),
  cancelPaymentIntent: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});

import { allocate } from "../../../lib/booking/allocation";

describe("Place a new time on a booking with no session left", () => {
  it.each([
    ["parked", { completionStatus: "RESCHEDULED", isTentative: true }],
    ["cancelled", { completionStatus: "CANCELLED", isTentative: false }],
  ] as const)(
    "allocates a fresh session when the old row is %s",
    async (_label, row) => {
      const host = await seedHost();
      await publishEveryHour(host);
      const consultee = await seedConsultee();
      const oldStart = futureAt(2, 9);
      const booking = await seedOneToOne(
        "consultation",
        host,
        consultee,
        { startsAt: oldStart, endsAt: new Date(oldStart.getTime() + HOUR_MS) },
        {
          status: "APPROVED",
          isTentative: row.isTentative,
          completionStatus: row.completionStatus,
          payment: { status: "SUCCEEDED", expiresAt: null },
        },
      );
      const consultationId = booking.consultationId;
      if (!consultationId) throw new Error("seed made no consultation");

      const newStart = futureAt(4, 11);
      const result = await allocate({
        eventType: "consultation",
        eventId: consultationId,
        mode: "manual",
        slots: halfHourStarts(newStart),
        override: true,
      });

      expect(result).toMatchObject({ success: true });
      const live = await prisma.appointmentOccurrence.findMany({
        where: {
          appointmentId: booking.appointmentId,
          deletedAt: null,
          completionStatus: "SCHEDULED",
        },
        select: { startsAt: true, isTentative: true },
      });
      expect(live).toEqual([{ startsAt: newStart, isTentative: false }]);
    },
  );
});
