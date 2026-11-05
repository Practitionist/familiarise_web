/**
 * setRegularTime: who may set it, the shape refusals, the edit boundary (the
 * first week holding nothing), replay, and the synchronous placement of this
 * week only, through the allocator with the `schedule:regular` reason.
 */
const mockPrisma = {
  subscription: { findUnique: jest.fn() },
  appointmentOccurrence: { findMany: jest.fn() },
  $transaction: jest.fn(),
};
const mockTx = {
  regularTime: { updateMany: jest.fn(), createMany: jest.fn() },
  subscription: { updateMany: jest.fn() },
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockPrisma;
  },
}));
jest.mock("@/lib/booking/allocation", () => ({ allocate: jest.fn() }));
jest.mock("@/lib/booking/allocation/event-data", () => ({
  fetchEventData: jest.fn(),
}));
jest.mock("@/lib/booking/cancel-actor", () => ({
  isHostOrgOperatorOf: jest.fn(),
}));
jest.mock("@/lib/novu/stage-bell", () => ({ stageBell: jest.fn() }));
jest.mock("@/lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(),
}));
jest.mock("@/utils/appointmentlock", () => ({
  withAppointmentLock: jest.fn((_id: string, fn: () => unknown) => fn()),
}));

import { allocate } from "@/lib/booking/allocation";
import { isHostOrgOperatorOf } from "@/lib/booking/cancel-actor";
import { stageBell } from "@/lib/novu/stage-bell";
import { setRegularTime } from "@/lib/booking/regular-time/service";
import { scheduleReason } from "@/lib/booking/allocation/schedule-choice";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Plan starts Mon 2 Nov 2026 00:00 IST; now is Mon 09:00 IST.
const START = new Date("2026-11-01T18:30:00Z");
const NOW = new Date("2026-11-02T03:30:00Z");
const MWF_1800 = [1, 3, 5].map((weekday) => ({
  weekday,
  localStartMinutes: 18 * 60,
}));

function occ(k: number, d: number) {
  const startsAt = new Date(START.getTime() + (7 * k + d) * DAY + 18 * HOUR);
  return {
    id: `o-${k}-${d}`,
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    completionStatus: "SCHEDULED",
    isTentative: false,
    deletedAt: null,
  };
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    status: "APPROVED",
    deletedAt: null,
    sessionsTotal: 78,
    sessionsPerWeek: 3,
    sessionMinutes: 60,
    sessionsRefunded: 0,
    schedulingPeriodStartsAt: START,
    schedulingTimezone: "Asia/Kolkata",
    planEndsAt: new Date(START.getTime() + 26 * 7 * DAY),
    rollPausedAt: null,
    lastRolledAt: null,
    requestedBy: { user: { id: "client-1", name: "Priya" } },
    subscriptionPlan: {
      title: "Maths",
      organizationId: "org-1",
      consultantProfileId: "cp-1",
      totalSessions: 78,
      sessionsPerWeek: 3,
      durationInMonths: 6,
      sessionDurationInHours: 1,
      consultantProfile: {
        user: { id: "expert-1", name: "Asha", timezone: "Asia/Kolkata" },
      },
    },
    appointment: { id: "appt-1", occurrences: [] as ReturnType<typeof occ>[] },
    regularTimes: [] as Array<Record<string, unknown>>,
    ...overrides,
  };
}

const liveRows = (validFrom: Date) =>
  MWF_1800.map((s, i) => ({
    id: `rt-${i}`,
    ...s,
    validFrom,
    validUntil: null,
  }));

const consultant = { userId: "expert-1", consultantProfileId: "cp-1" };

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.appointmentOccurrence.findMany.mockResolvedValue([]);
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(mockTx),
  );
  mockTx.regularTime.updateMany.mockImplementation(
    ({ where }: { where: { id: { in: string[] } } }) => ({
      count: where.id.in.length,
    }),
  );
  mockTx.regularTime.createMany.mockResolvedValue({ count: 3 });
  mockTx.subscription.updateMany.mockResolvedValue({ count: 1 });
  (stageBell as jest.Mock).mockResolvedValue({ id: "bell-1" });
  (allocate as jest.Mock).mockResolvedValue({ success: true });
  (isHostOrgOperatorOf as jest.Mock).mockResolvedValue(false);
});

describe("setRegularTime", () => {
  it("T11: places this week now (≤ perWeek, schedule:regular) and stages one client notice", async () => {
    mockPrisma.subscription.findUnique
      .mockResolvedValueOnce(plan())
      .mockResolvedValueOnce(plan({ regularTimes: liveRows(START) }));
    const out = await setRegularTime(consultant, "sub-1", MWF_1800, NOW);
    expect(out).toMatchObject({ ok: true, placed: 3, replayed: false });
    expect(allocate).toHaveBeenCalledTimes(3);
    expect((allocate as jest.Mock).mock.calls[0][0]).toMatchObject({
      mode: "manual",
      byRegularTime: true,
      topUp: true,
      allowPartial: true,
      slots: ["2026-11-02T12:30:00.000Z", "2026-11-02T13:00:00.000Z"],
    });
    expect(stageBell).toHaveBeenCalledTimes(1);
    expect((stageBell as jest.Mock).mock.calls[0][1]).toMatchObject({
      recipients: ["client-1"],
      dedupeKey: `regular-time:sub-1:${START.toISOString()}`,
      payload: { regularTime: "Mon, Wed, Fri at 18:00 (Asia/Kolkata)" },
    });
    expect(mockTx.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { rollPausedAt: null } }),
    );
    expect(
      scheduleReason({
        mode: "manual",
        placedBefore: true,
        releasedBefore: 0,
        byRegularTime: true,
        byConsultant: true,
      }),
    ).toBe("schedule:regular");
  });

  it("T12: the client is refused; a host-org operator may; another org may not", async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue(plan());
    expect(
      await setRegularTime(
        { userId: "client-1", consultantProfileId: null },
        "sub-1",
        MWF_1800,
        NOW,
      ),
    ).toMatchObject({ ok: false, status: 403, code: "NOT_ALLOWED" });

    expect(
      await setRegularTime(
        { userId: "other-org-admin", consultantProfileId: null },
        "sub-1",
        MWF_1800,
        NOW,
      ),
    ).toMatchObject({ ok: false, status: 403 });

    (isHostOrgOperatorOf as jest.Mock).mockResolvedValue(true);
    expect(
      await setRegularTime(
        { userId: "org-operator", consultantProfileId: null },
        "sub-1",
        MWF_1800,
        NOW,
      ),
    ).toMatchObject({ ok: true });
    expect(isHostOrgOperatorOf).toHaveBeenLastCalledWith(
      "org-operator",
      "org-1",
    );
  });

  it("T13: an edit applies from the first week holding nothing; placed rows stay; a replay writes nothing", async () => {
    const placed = [occ(0, 0), occ(0, 2), occ(0, 4), occ(1, 0)];
    const editable = plan({
      regularTimes: liveRows(START),
      appointment: { id: "appt-1", occurrences: placed },
    });
    mockPrisma.subscription.findUnique.mockResolvedValue(editable);
    const edited = [1, 2, 4].map((weekday) => ({
      weekday,
      localStartMinutes: 9 * 60,
    }));
    const out = await setRegularTime(consultant, "sub-1", edited, NOW);
    const week2 = new Date(START.getTime() + 14 * DAY);
    expect(out).toMatchObject({ ok: true, validFrom: week2, placed: 0 });
    expect(mockTx.regularTime.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["rt-0", "rt-1", "rt-2"] },
        subscriptionId: "sub-1",
        validUntil: null,
      },
      data: { validUntil: week2 },
    });
    expect(allocate).not.toHaveBeenCalled();

    jest.clearAllMocks();
    const replay = await setRegularTime(consultant, "sub-1", MWF_1800, NOW);
    expect(replay).toMatchObject({ ok: true, replayed: true, placed: 0 });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("T13: a concurrent edit that closed the rows first is a plain 409", async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue(
      plan({ regularTimes: liveRows(START) }),
    );
    mockTx.regularTime.updateMany.mockResolvedValue({ count: 1 });
    const out = await setRegularTime(
      consultant,
      "sub-1",
      [1, 2, 4].map((weekday) => ({ weekday, localStartMinutes: 600 })),
      NOW,
    );
    expect(out).toMatchObject({ status: 409, code: "REGULAR_TIME_CHANGED" });
    expect(mockTx.regularTime.createMany).not.toHaveBeenCalled();
  });

  it("T14: wrong count, two on one day and off-grid are plain refusals", async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue(plan());
    expect(
      await setRegularTime(consultant, "sub-1", MWF_1800.slice(0, 2), NOW),
    ).toMatchObject({ status: 400, code: "REGULAR_TIME_SLOT_COUNT" });
    expect(
      await setRegularTime(
        consultant,
        "sub-1",
        [
          { weekday: 1, localStartMinutes: 600 },
          { weekday: 1, localStartMinutes: 900 },
          { weekday: 3, localStartMinutes: 600 },
        ],
        NOW,
      ),
    ).toMatchObject({ status: 409, code: "REGULAR_TIME_SAME_DAY" });
    mockPrisma.subscription.findUnique.mockResolvedValue(
      plan({ schedulingTimezone: "Asia/Kathmandu" }),
    );
    const offGrid = await setRegularTime(
      consultant,
      "sub-1",
      [1, 3, 5].map((weekday) => ({ weekday, localStartMinutes: 9 * 60 })),
      NOW,
    );
    expect(offGrid).toMatchObject({
      status: 409,
      code: "REGULAR_TIME_OFF_GRID",
    });
    expect(offGrid.ok ? "" : offGrid.error).toContain("08:45 or 09:15");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
