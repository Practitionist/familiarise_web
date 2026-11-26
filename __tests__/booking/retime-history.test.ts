/**
 * @jest-environment node
 */

/**
 * A webinar re-time and a class series move each leave one history row per
 * moved session, in the move's own transaction, naming who moved it and why.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findUnique: jest.fn() },
    class: { findUnique: jest.fn() },
    appointmentOccurrence: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock("../../utils/appointmentlock", () => ({
  withEventCheckoutLock: jest.fn((_scope: unknown, run: () => unknown) =>
    run(),
  ),
  withAppointmentLock: jest.fn((_id: unknown, run: () => unknown) => run()),
}));
jest.mock("../../lib/booking/host-slot-batch", () => ({
  acceptedCohostProfileIds: jest.fn(async () => []),
  hostBatchEntries: jest.fn(() => []),
  lockHostBatchInTx: jest.fn(async () => undefined),
  lockPlanForMove: jest.fn(async () => undefined),
  withHostSlotBatch: jest.fn((_entries: unknown, run: () => unknown) => run()),
}));
jest.mock("../../lib/booking/class-sessions", () => ({
  verifyCohostsFreeForMove: jest.fn(async () => undefined),
  verifyHostFreeForMove: jest.fn(async () => undefined),
}));
jest.mock("../../lib/booking/retime-leave", () => ({
  attendeeClashes: jest.fn(async () => []),
  extendRetimeLeave: jest.fn(async (..._a: unknown[]) => new Date()),
  RETIME_TX_OPTIONS: {},
  retimeLeaveUntil: jest.fn(() => new Date()),
  splitByClash: jest.fn(() => []),
}));
jest.mock("../../lib/booking/allocation/event-data", () => ({
  followClassSessions: jest.fn(async () => undefined),
}));
jest.mock("../../lib/payments/payouts/earnings-hold", () => ({
  recomputeEarningsHold: jest.fn(async () => undefined),
}));
jest.mock("../../lib/collaborators/recipients", () => ({
  collaboratorUserIds: jest.fn(async () => []),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyAppointmentRescheduled: jest.fn(async () => []),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(async () => undefined),
}));
jest.mock("../../lib/email/senders/booking", () => ({
  stageAppointmentRescheduledEmail: jest.fn(async () => []),
}));

import prisma from "@/lib/prisma";
import { retimeClassSeries } from "@/lib/booking/class-retime";
import { retimeWebinar } from "@/lib/booking/event-retime";
import type { HostedClass } from "@/lib/booking/class-sessions";

const db = prisma as unknown as {
  appointment: { findUnique: jest.Mock };
  class: { findUnique: jest.Mock };
  appointmentOccurrence: { findMany: jest.Mock };
  $transaction: jest.Mock;
};

const HOUR = 3_600_000;
const onGrid = (hoursAhead: number) =>
  new Date(Math.ceil((Date.now() + hoursAhead * HOUR) / 1_800_000) * 1_800_000);

type Row = {
  id: string;
  appointmentId: string;
  startsAt: Date;
  endsAt: Date;
  completionStatus: string;
  isTentative: boolean;
  consultantProfileId: string;
};
type RowWhere = {
  id?: string;
  startsAt?: Date;
  isTentative?: boolean;
  OR?: { id: string; startsAt: Date }[];
};

const session = (id: string, hoursAhead: number): Row => ({
  id,
  appointmentId: "apt-1",
  startsAt: onGrid(hoursAhead),
  endsAt: new Date(onGrid(hoursAhead).getTime() + HOUR),
  completionStatus: "SCHEDULED",
  isTentative: false,
  consultantProfileId: "profile-1",
});

/** The session rows of one event, moved the way the writes ask. */
function fakeTx(rows: Row[]) {
  const history: Record<string, unknown>[] = [];
  const matching = (where: RowWhere) =>
    rows
      .filter((row) => {
        const named = where.OR ?? (where.id ? [{ id: where.id }] : null);
        if (!named) return true;
        return named.some(
          (n: { id: string; startsAt?: Date }) =>
            n.id === row.id &&
            (!n.startsAt || n.startsAt.getTime() === row.startsAt.getTime()),
        );
      })
      .filter(
        (row) =>
          !where.startsAt ||
          !(where.startsAt instanceof Date) ||
          where.startsAt.getTime() === row.startsAt.getTime(),
      )
      .filter(
        (row) =>
          where.isTentative === undefined ||
          where.isTentative === row.isTentative,
      );
  const write = (where: RowWhere, data: Partial<Row>) => {
    const hit = matching(where);
    for (const row of hit) Object.assign(row, data);
    return hit;
  };
  const tx = {
    class: {
      findUnique: jest.fn(async () => ({
        status: "SCHEDULED",
        schedulingTimezone: "Asia/Kolkata",
      })),
    },
    appointmentParticipant: { findMany: jest.fn(async () => []) },
    appointmentOccurrence: {
      findMany: jest.fn(async ({ where }: { where: RowWhere }) =>
        matching(where).map((row) => ({ ...row })),
      ),
      updateMany: jest.fn(
        async ({ where, data }: { where: RowWhere; data: Partial<Row> }) => ({
          count: write(where, data).length,
        }),
      ),
      updateManyAndReturn: jest.fn(
        async ({ where, data }: { where: RowWhere; data: Partial<Row> }) =>
          write(where, data).map((row) => ({
            id: row.id,
            appointmentId: row.appointmentId,
          })),
      ),
    },
    bookingStatusHistory: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        history.push(data);
        return data;
      }),
    },
  };
  db.$transaction.mockImplementation((run: (t: unknown) => unknown) => run(tx));
  return { tx, history };
}

beforeEach(() => jest.clearAllMocks());

it("writes one history row for a re-timed webinar, with who moved it", async () => {
  const live = session("occ-1", 72);
  const from = live.startsAt;
  const to = onGrid(120);
  db.appointment.findUnique.mockResolvedValue({
    organizationId: "org-1",
    webinar: {
      id: "web-1",
      status: "SCHEDULED",
      webinarPlan: {
        id: "plan-1",
        title: "Intro to Spanish",
        consultantProfileId: "profile-1",
        consultantProfile: { user: { id: "host", name: "Hannah" } },
      },
    },
    occurrences: [{ ...live }],
  });
  const { history } = fakeTx([live]);

  await retimeWebinar({
    appointmentId: "apt-1",
    startsAt: to,
    actorUserId: "host",
  });

  expect(live.startsAt).toEqual(to);
  expect(live.startsAt).not.toEqual(from);
  expect(history).toEqual([
    expect.objectContaining({
      entity: "OCCURRENCE",
      entityId: "occ-1",
      fromStatus: "SCHEDULED",
      toStatus: "SCHEDULED",
      actorUserId: "host",
      reason: "Moved to a new time",
      appointmentId: "apt-1",
      organizationId: "org-1",
    }),
  ]);
});

it("writes one history row per session a class series move re-timed", async () => {
  const rows = [session("occ-1", 72), session("occ-2", 120)];
  db.class.findUnique.mockResolvedValue({ status: "SCHEDULED" });
  db.appointmentOccurrence.findMany.mockResolvedValue(
    rows.map((row) => ({ ...row })),
  );
  const { history } = fakeTx(rows);
  const starts = [onGrid(200), onGrid(300)];

  const result = await retimeClassSeries({
    hosted: {
      found: true,
      appointment: { id: "apt-1", organizationId: null },
      cls: {
        id: "class-1",
        classPlan: {
          id: "plan-1",
          title: "Spanish B1",
          consultantProfileId: "profile-1",
          consultantProfile: { user: { id: "host", name: "Hannah" } },
        },
      },
    } as unknown as HostedClass,
    starts,
    actorUserId: "host",
  });

  expect(result.moved).toBe(2);
  expect(rows.map((row) => row.startsAt)).toEqual(starts);
  expect(rows.every((row) => !row.isTentative)).toBe(true);
  expect(history).toHaveLength(2);
  expect(history.map((row) => row.entityId).sort()).toEqual(["occ-1", "occ-2"]);
  for (const row of history) {
    expect(row).toMatchObject({
      entity: "OCCURRENCE",
      fromStatus: "SCHEDULED",
      toStatus: "SCHEDULED",
      actorUserId: "host",
      reason: "Moved to a new time",
      appointmentId: "apt-1",
    });
  }
});
