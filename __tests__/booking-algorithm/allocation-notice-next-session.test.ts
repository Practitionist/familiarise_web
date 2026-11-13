/**
 * @jest-environment node
 */

// Invariant: the booked notice after a top-up names the next live session, never a past or cancelled one.

import "./setup";
import { notifyAppointmentBooked } from "@/lib/novu";
import { stageAllocationNotices } from "@/lib/booking/allocation/notify";
import type { Tx } from "@/lib/prisma";

const DAY = 24 * 3600_000;
const row = (offsetDays: number, completionStatus: string) => ({
  startsAt: new Date(Date.now() + offsetDays * DAY),
  completionStatus,
  isTentative: false,
  deletedAt: null,
});
const OCCURRENCES = [
  row(-7, "COMPLETED"),
  row(-1, "SCHEDULED"),
  row(2, "CANCELLED"),
  row(5, "SCHEDULED"),
];

type OccurrenceWhere = {
  completionStatus?: { in: string[] };
  startsAt?: { gte: Date };
  isTentative?: boolean;
};

const tx = {
  subscription: {
    findUnique: async (args: {
      select: {
        appointment: { select: { occurrences: { where: OccurrenceWhere } } };
      };
    }) => {
      const where = args.select.appointment.select.occurrences.where;
      const live = OCCURRENCES.filter(
        (o) =>
          (!where.completionStatus ||
            where.completionStatus.in.includes(o.completionStatus)) &&
          (!where.startsAt || o.startsAt >= where.startsAt.gte) &&
          (where.isTentative === undefined ||
            o.isTentative === where.isTentative),
      ).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      return {
        subscriptionPlan: {
          title: "Weekly coaching",
          consultantProfile: { user: { id: "consultant-1", name: "Host" } },
        },
        requestedBy: { user: { id: "consultee-1", name: "Buyer" } },
        appointment: {
          id: "appt-1",
          organizationId: null,
          occurrences: live.slice(0, 1),
        },
      };
    },
  },
} as unknown as Tx;

it("names the next live session on a subscription top-up", async () => {
  await stageAllocationNotices(tx, "subscription", "sub-1");

  const payload = (notifyAppointmentBooked as jest.Mock).mock.calls[0][1];
  expect(payload.dateTime).toBe(OCCURRENCES[3].startsAt.toISOString());
});

it("keys each placement batch apart, so week two is not deduplicated into week one", async () => {
  (notifyAppointmentBooked as jest.Mock).mockClear();
  const week = (days: number) => [new Date(Date.UTC(2030, 0, days, 9))];
  await stageAllocationNotices(
    tx,
    "subscription",
    "sub-1",
    undefined,
    undefined,
    week(1),
  );
  await stageAllocationNotices(
    tx,
    "subscription",
    "sub-1",
    undefined,
    undefined,
    week(8),
  );

  const keys = (notifyAppointmentBooked as jest.Mock).mock.calls.map(
    ([, , opts]) => opts.dedupeKey,
  );
  expect(keys[0]).not.toEqual(keys[1]);
});
