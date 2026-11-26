/**
 * @jest-environment node
 */

/**
 * The series re-time refuses before taking any lock: an off-grid or too-soon
 * start, a class that isn't published, nothing 24 hours away, or a count that
 * doesn't match the movable sessions.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    class: { findUnique: jest.fn() },
    appointmentOccurrence: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock("../../utils/appointmentlock", () => ({
  withEventCheckoutLock: jest.fn(),
  withAppointmentLock: jest.fn(),
}));
jest.mock("../../lib/booking/host-slot-batch", () => ({
  acceptedCohostProfileIds: jest.fn(async () => []),
  hostBatchEntries: jest.fn(() => []),
  lockHostBatchInTx: jest.fn(async () => undefined),
  lockPlanForMove: jest.fn(async () => undefined),
  withHostSlotBatch: jest.fn((_entries: unknown, run: () => unknown) => run()),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyAppointmentRescheduled: jest.fn(),
}));

import prisma from "@/lib/prisma";
import { retimeClassSeries } from "@/lib/booking/class-retime";
import {
  withAppointmentLock,
  withEventCheckoutLock,
} from "@/utils/appointmentlock";
import type { HostedClass } from "@/lib/booking/class-sessions";

const db = prisma as unknown as {
  class: { findUnique: jest.Mock };
  appointmentOccurrence: { findMany: jest.Mock };
};

const hosted = {
  found: true,
  appointment: { id: "apt-1", organizationId: null },
  cls: {
    id: "class-1",
    classPlan: {
      id: "plan-1",
      title: "Spanish B1",
      consultantProfileId: "profile-1",
      consultantProfile: { user: { id: "host", name: "Priya" } },
    },
  },
} as unknown as HostedClass;

const HOUR = 3_600_000;
const onGrid = (hoursAhead: number) =>
  new Date(Math.ceil((Date.now() + hoursAhead * HOUR) / 1_800_000) * 1_800_000);

beforeEach(() => {
  jest.clearAllMocks();
  db.class.findUnique.mockResolvedValue({ status: "SCHEDULED" });
  db.appointmentOccurrence.findMany.mockResolvedValue([
    {
      id: "occ-1",
      startsAt: onGrid(72),
      endsAt: new Date(onGrid(72).getTime() + HOUR),
      consultantProfileId: "profile-1",
    },
    {
      id: "occ-2",
      startsAt: onGrid(120),
      endsAt: new Date(onGrid(120).getTime() + HOUR),
      consultantProfileId: "profile-1",
    },
  ]);
});

it("refuses a new time inside 24 hours", async () => {
  await expect(
    retimeClassSeries({
      hosted,
      starts: [onGrid(5), onGrid(200)],
      actorUserId: "host",
    }),
  ).rejects.toMatchObject({ code: "EVENT_TIME_INVALID" });
  expect(withEventCheckoutLock).not.toHaveBeenCalled();
});

it("refuses a count that doesn't match the movable sessions", async () => {
  await expect(
    retimeClassSeries({ hosted, starts: [onGrid(200)], actorUserId: "host" }),
  ).rejects.toMatchObject({
    code: "RETIME_NOT_ALLOWED",
    message: "Pick 2 new times, one for each session at least 24 hours away.",
  });
});

it("refuses overlapping new times", async () => {
  const start = onGrid(200);
  await expect(
    retimeClassSeries({
      hosted,
      starts: [start, new Date(start.getTime() + 30 * 60_000)],
      actorUserId: "host",
    }),
  ).rejects.toMatchObject({ code: "EVENT_TIME_INVALID" });
});

it("refuses a class that isn't published", async () => {
  db.class.findUnique.mockResolvedValue({ status: "DRAFT" });
  await expect(
    retimeClassSeries({
      hosted,
      starts: [onGrid(200), onGrid(300)],
      actorUserId: "host",
    }),
  ).rejects.toMatchObject({ code: "RETIME_NOT_ALLOWED" });
});

it("points at cancel + make-up when nothing is 24 hours away", async () => {
  db.appointmentOccurrence.findMany.mockResolvedValue([]);
  await expect(
    retimeClassSeries({ hosted, starts: [onGrid(200)], actorUserId: "host" }),
  ).rejects.toMatchObject({ code: "RETIME_NOT_ALLOWED" });
});

it("refuses a move whose sessions changed after it read them, and writes nothing", async () => {
  // Another move committed first: the same rows now sit at different times.
  const tx = {
    class: {
      findUnique: jest.fn(async () => ({
        status: "SCHEDULED",
        schedulingTimezone: "Asia/Kolkata",
      })),
    },
    appointmentOccurrence: {
      findMany: jest.fn(async () => [
        {
          id: "occ-1",
          startsAt: onGrid(96),
          endsAt: new Date(onGrid(96).getTime() + HOUR),
        },
        {
          id: "occ-2",
          startsAt: onGrid(144),
          endsAt: new Date(onGrid(144).getTime() + HOUR),
        },
      ]),
      updateMany: jest.fn(),
    },
  };
  (withEventCheckoutLock as jest.Mock).mockImplementation(
    (_scope: unknown, run: () => unknown) => run(),
  );
  (withAppointmentLock as jest.Mock).mockImplementation(
    (_id: unknown, run: () => unknown) => run(),
  );
  (prisma.$transaction as jest.Mock).mockImplementation(
    (run: (t: unknown) => unknown) => run(tx),
  );
  await expect(
    retimeClassSeries({
      hosted,
      starts: [onGrid(200), onGrid(300)],
      actorUserId: "host",
    }),
  ).rejects.toMatchObject({
    code: "RETIME_NOT_ALLOWED",
    message:
      "This class changed while you were moving it. Refresh and try again.",
  });
  expect(tx.appointmentOccurrence.updateMany).not.toHaveBeenCalled();
});
