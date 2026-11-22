/**
 * @jest-environment node
 */

// Invariant: the booked notice after a top-up names the next live session, never a past or cancelled one.

import "./setup";
import {
  notifyAppointmentBooked,
  notifyAppointmentPartiallyScheduled,
} from "@/lib/novu";
import { stageAllocationNotices } from "@/lib/booking/allocation/notify";
import type { Tx } from "@/lib/prisma";
import { matchesWhere, type Where } from "../fixtures/mem-db";

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
  const week = (days: number) => [`occ-week-${days}`];
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

describe("a webinar or class allocation tells the team, read from the plan", () => {
  const user = (id: string) => ({ id, name: id });
  // The former collaborator still has a live staff row; the current one has none.
  const SEATS = [
    { role: "CONSULTANT", status: "CONFIRMED", user: user("host") },
    { role: "CONSULTEE", status: "CONFIRMED", user: user("learner") },
    { role: "COLLABORATOR", status: "CONFIRMED", user: user("left-the-team") },
  ];
  const TEAM = [
    {
      webinarPlanId: "plan-1",
      classPlanId: "plan-1",
      status: "ACCEPTED",
      consultantProfile: { deletedAt: null, userId: "on-the-team" },
    },
    {
      webinarPlanId: "plan-1",
      classPlanId: "plan-1",
      status: "REMOVED",
      consultantProfile: { deletedAt: null, userId: "left-the-team" },
    },
  ];
  const event = async (args: {
    select: { appointment: { select: { participants: { where: Where } } } };
  }) => {
    const plan = {
      id: "plan-1",
      title: "Open session",
      consultantProfile: { user: user("host") },
    };
    return {
      webinarPlan: plan,
      classPlan: plan,
      appointment: {
        id: "appt-1",
        organizationId: null,
        participants: SEATS.filter((seat) =>
          matchesWhere(seat, args.select.appointment.select.participants.where),
        ),
        occurrences: [row(5, "SCHEDULED")],
      },
    };
  };
  const groupTx = {
    webinar: { findUnique: event },
    class: { findUnique: event },
    collaborator: {
      findMany: async ({ where }: { where: Where }) =>
        TEAM.filter((member) => matchesWhere(member, where)),
    },
  } as unknown as Tx;

  it.each(["webinar", "class"] as const)(
    "sends the %s notice to the host, the learners and the current team only",
    async (eventType) => {
      (notifyAppointmentBooked as jest.Mock).mockClear();
      (notifyAppointmentPartiallyScheduled as jest.Mock).mockClear();
      await stageAllocationNotices(groupTx, eventType, "event-1", {
        partial: true,
      });

      const [recipients, payload] = (notifyAppointmentBooked as jest.Mock).mock
        .calls[0];
      expect([...recipients].sort()).toEqual([
        "host",
        "learner",
        "on-the-team",
      ]);
      expect(payload.consulteeName).toBe("learner");
      // What happens to the unplaced sessions is the learners' notice alone.
      expect(
        (notifyAppointmentPartiallyScheduled as jest.Mock).mock.calls[0][0],
      ).toEqual(["learner"]);
    },
  );
});
