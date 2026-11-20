/**
 * @jest-environment node
 */

// Invariant: the booked notice after a top-up names the next live session, never a past or cancelled one.

import "./setup";

const mockBookedEmail = jest.fn(async (..._a: unknown[]) => []);
jest.mock("../../lib/email/senders/booking", () => ({
  stageAppointmentBookedEmail: (...a: unknown[]) => mockBookedEmail(...a),
}));
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
  // The booking already holds sessions from earlier batches.
  appointmentOccurrence: { count: async () => OCCURRENCES.length },
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

it("a run that confirms a reschedule stages no booked notice: its moved notice is the one", async () => {
  (notifyAppointmentBooked as jest.Mock).mockClear();
  const staged = await stageAllocationNotices(
    tx,
    "subscription",
    "sub-1",
    undefined,
    "approved",
    ["occ-moved"],
    true,
  );

  expect(staged).toEqual([]);
  expect(notifyAppointmentBooked).not.toHaveBeenCalled();
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

describe("each side's notice is in its own scope", () => {
  const sponsoredTx = {
    appointmentOccurrence: { count: async () => 1 },
    consultation: {
      findUnique: async () => ({
        consultationPlan: {
          title: "One-off advice",
          // The expert's own plan; the learner's employer pays.
          organizationId: null,
          consultantProfile: { user: { id: "expert", name: "Dr Rao" } },
        },
        requestedBy: { user: { id: "learner", name: "Priya" } },
        appointment: {
          id: "appt-1",
          organizationId: "org-sponsor",
          occurrences: [row(5, "SCHEDULED")],
        },
      }),
    },
  } as unknown as Tx;

  it("a sponsored booking on a personal plan: the expert's bell is personal, the learner's is the sponsor's", async () => {
    (notifyAppointmentBooked as jest.Mock).mockClear();
    (notifyAppointmentPartiallyScheduled as jest.Mock).mockClear();
    await stageAllocationNotices(
      sponsoredTx,
      "consultation",
      "c-1",
      { partial: true },
      undefined,
      ["occ-1"],
    );

    const calls = (notifyAppointmentBooked as jest.Mock).mock.calls;
    expect(calls.map(([ids]) => ids)).toEqual([["expert"], ["learner"]]);
    expect(calls[0][1]).toMatchObject({
      scope: "personal",
      organizationId: null,
    });
    expect(calls[0][1].dashboardUrl).toContain(
      "/dashboard/go/auto/appointments",
    );
    expect(calls[1][1]).toMatchObject({
      scope: "org",
      organizationId: "org-sponsor",
    });
    expect(calls[1][1].dashboardUrl).toContain(
      "/dashboard/organization/org-sponsor/appointments",
    );
    // One real-world event: both sends share the batch's key.
    expect(calls[0][2].dedupeKey).toBe(calls[1][2].dedupeKey);
    const [partialIds, partialPayload] = (
      notifyAppointmentPartiallyScheduled as jest.Mock
    ).mock.calls[0];
    expect(partialIds).toEqual(["learner"]);
    expect(partialPayload.scope).toBe("org");
  });
});

describe("times placed after payment: one scheduled email on the booking's first placement", () => {
  const PLACED = [
    { id: "occ-1", startsAt: new Date(Date.now() + 2 * DAY) },
    { id: "occ-2", startsAt: new Date(Date.now() + 9 * DAY) },
  ].map((o) => ({ ...o, endsAt: new Date(o.startsAt.getTime() + 3600_000) }));
  const paidPlanTx = (over: { earlierRows?: number; bookedEmail?: boolean }) =>
    ({
      subscription: {
        findUnique: async () => ({
          subscriptionPlan: {
            title: "Weekly coaching",
            organizationId: null,
            consultantProfile: { user: { id: "expert", name: "Dr Rao" } },
          },
          requestedBy: { user: { id: "learner", name: "Priya" } },
          appointment: {
            id: "appt-1",
            organizationId: null,
            occurrences: [PLACED[0]],
          },
        }),
      },
      appointmentOccurrence: {
        count: jest.fn(async () => over.earlierRows ?? 0),
        findMany: jest.fn(async () =>
          PLACED.map(({ startsAt, endsAt }) => ({ startsAt, endsAt })),
        ),
      },
      failedEmail: {
        findFirst: jest.fn(async () =>
          over.bookedEmail ? { id: "fe-1" } : null,
        ),
      },
    }) as unknown as Tx;
  const place = (tx: Tx, outcome?: "approved" | "awaiting_payment") =>
    stageAllocationNotices(
      tx,
      "subscription",
      "sub-1",
      undefined,
      outcome,
      PLACED.map((o) => o.id),
    );

  beforeEach(() => mockBookedEmail.mockClear());

  it("stages one email to the learner, in the allocation transaction, listing the placed sessions", async () => {
    const tx = paidPlanTx({});
    await place(tx, "approved");

    expect(mockBookedEmail).toHaveBeenCalledTimes(1);
    const [usedTx, email] = mockBookedEmail.mock.calls[0] as [
      Tx,
      Record<string, unknown>,
    ];
    expect(usedTx).toBe(tx);
    expect(email).toMatchObject({
      appointmentId: "appt-1",
      consulteeUserId: "learner",
      // The expert placed the times; only the learner is mailed.
      consultantUserId: null,
      consultantName: "Dr Rao",
      planTitle: "Weekly coaching",
      startsAt: PLACED[0].startsAt,
    });
    expect(email.sessions).toEqual(
      PLACED.map(({ startsAt, endsAt }) => ({ startsAt, endsAt })),
    );
  });

  it("a later batch is bell-only", async () => {
    await place(paidPlanTx({ earlierRows: 4 }), "approved");
    expect(mockBookedEmail).not.toHaveBeenCalled();
  });

  it("a booking whose booked email already went is not mailed again", async () => {
    await place(paidPlanTx({ bookedEmail: true }), "approved");
    expect(mockBookedEmail).not.toHaveBeenCalled();
  });

  it("nothing is mailed while the booking still awaits payment", async () => {
    await place(paidPlanTx({}), "awaiting_payment");
    expect(mockBookedEmail).not.toHaveBeenCalled();
  });
});
