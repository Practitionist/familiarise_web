/**
 * @jest-environment node
 */

/**
 * D8/D9 — returning one subscription session to the plan (24 h boundary, the
 * cap of 2 with a racing loser, the 7-day extension once, the allowance, the
 * consultee-only door) and D10 — the strike writer and the completion rate.
 */

const NOW = new Date("2026-11-02T10:00:00.000Z");
const HOUR = 3_600_000;
const END = new Date("2026-11-30T00:00:00.000Z");

const state = {
  startsAt: new Date(NOW.getTime() + 25 * HOUR),
  sessionsReturned: 0,
  spentCount: 1,
};
const tx = {
  $queryRaw: jest.fn(async () => [{ now: NOW }]),
  appointmentOccurrence: {
    findUnique: jest.fn(async () => ({
      id: "occ-1",
      appointmentId: "appt-1",
      startsAt: state.startsAt,
      completionStatus: "SCHEDULED",
      isTentative: false,
      deletedAt: null,
      appointment: {
        organizationId: null,
        subscription: {
          id: "sub-1",
          status: "APPROVED",
          requestedById: "cee-1",
          sessionsReturned: state.sessionsReturned,
          schedulingPeriodEndsAt: END,
          requestedBy: { user: { name: "Asha" } },
          subscriptionPlan: {
            title: "Weekly",
            consultantProfile: { user: { id: "u-expert", name: "Ravi" } },
          },
        },
      },
    })),
    findMany: jest.fn(async () => [
      { id: "occ-1", completionStatus: "SCHEDULED" },
    ]),
    updateManyAndReturn: jest.fn(async () => [
      { id: "occ-1", appointmentId: "appt-1" },
    ]),
  },
  rescheduleRequest: { findFirst: jest.fn(async () => null) },
  dispute: { findFirst: jest.fn(async () => null) },
  subscription: {
    updateMany: jest.fn(async () => ({ count: state.spentCount })),
  },
  bookingStatusHistory: { create: jest.fn(async () => ({})) },
  user: { findMany: jest.fn(async () => []) },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: (fn: (t: unknown) => unknown) => fn(tx) },
}));
jest.mock("../../utils/appointmentlock", () => ({
  withAppointmentLock: (_id: string, fn: () => unknown) => fn(),
}));
const stageBell = jest.fn(async () => ({ id: "bell-1" }));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: (...a: unknown[]) => stageBell(...(a as [])),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(async () => undefined),
}));
jest.mock("../../lib/email/senders/booking", () => ({
  stageAppointmentCancelledEmail: jest.fn(async () => []),
}));

import { returnSessionToPlan } from "@/lib/booking/session-return";
import { subscriptionEntitlement } from "@/lib/booking/entitlement";
import { recordExpertStrike } from "@/lib/booking/expert-reliability";
import { computeConsultantCompletionRate } from "@/lib/data/consultant-dashboard";

const run = () =>
  returnSessionToPlan({
    appointmentId: "appt-1",
    occurrenceId: "occ-1",
    actorUserId: "u-cee",
    consulteeProfileId: "cee-1",
  });

beforeEach(() => {
  jest.clearAllMocks();
  state.startsAt = new Date(NOW.getTime() + 25 * HOUR);
  state.sessionsReturned = 0;
  state.spentCount = 1;
});

describe("returning a subscription session to the plan", () => {
  it("releases it by CAS, spends one return and extends the plan by exactly 7 days", async () => {
    const out = await run();
    const cas = tx.appointmentOccurrence.updateManyAndReturn.mock
      .calls[0] as unknown as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ];
    expect(cas[0].where).toMatchObject({
      id: "occ-1",
      completionStatus: { in: ["SCHEDULED"] },
    });
    expect(cas[0].data).toEqual({ completionStatus: "CANCELLED" });
    expect(tx.subscription.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.subscription.updateMany).toHaveBeenCalledWith({
      where: {
        id: "sub-1",
        status: "APPROVED",
        sessionsReturned: { lt: 2 },
        schedulingPeriodEndsAt: END,
      },
      data: {
        sessionsReturned: { increment: 1 },
        schedulingPeriodEndsAt: new Date(END.getTime() + 7 * 24 * HOUR),
      },
    });
    expect(out.sessionsReturned).toBe(1);
    expect(stageBell).toHaveBeenCalledTimes(1);
  });

  it("refuses inside 24 h of DB now() and accepts at exactly 24 h", async () => {
    state.startsAt = new Date(NOW.getTime() + 24 * HOUR - 1);
    await expect(run()).rejects.toMatchObject({ code: "RETURN_WINDOW_CLOSED" });
    state.startsAt = new Date(NOW.getTime() + 24 * HOUR);
    await expect(run()).resolves.toMatchObject({ occurrenceId: "occ-1" });
  });

  it("refuses a third return, and the racing loser of the counter CAS", async () => {
    state.sessionsReturned = 2;
    await expect(run()).rejects.toMatchObject({ code: "RETURN_CAP_REACHED" });
    state.sessionsReturned = 1;
    state.spentCount = 0;
    await expect(run()).rejects.toMatchObject({ code: "RETURN_CAP_REACHED" });
    expect(stageBell).not.toHaveBeenCalled();
  });

  it("answers 403 to anyone but the plan's consultee", async () => {
    await expect(
      returnSessionToPlan({
        appointmentId: "appt-1",
        occurrenceId: "occ-1",
        actorUserId: "u-expert",
        consulteeProfileId: null,
      }),
    ).rejects.toMatchObject({ name: "SessionReturnForbiddenError" });
  });

  it("counts a returned session as re-bookable in the allowance", () => {
    const occ = (completionStatus: string) => ({
      startsAt: new Date(NOW.getTime() + 25 * HOUR),
      endsAt: new Date(NOW.getTime() + 26 * HOUR),
      completionStatus,
    });
    const base = {
      sessionsTotal: 4,
      sessionsPerWeek: 1,
      durationInMonths: 1,
      schedulingPeriodStartsAt: NOW,
      schedulingTimezone: "Asia/Kolkata",
      now: NOW,
    };
    const before = subscriptionEntitlement({
      ...base,
      occurrences: [occ("SCHEDULED")],
    });
    const after = subscriptionEntitlement({
      ...base,
      occurrences: [occ("CANCELLED")],
    });
    expect(after.remaining).toBe(before.remaining + 1);
  });
});

describe("expert reliability strikes", () => {
  it("writes one strike on the expert's correlation, and none for a platform void", async () => {
    const create = jest.fn(async () => ({}));
    const db = { systemEvent: { create } } as never;
    await expect(
      recordExpertStrike(db, {
        consultantProfileId: "cp-1",
        cause: "PLATFORM_VOID",
        appointmentId: "appt-1",
      }),
    ).resolves.toBe(false);
    await recordExpertStrike(db, {
      consultantProfileId: "cp-1",
      cause: "EXPERT_CANCEL",
      appointmentId: "appt-1",
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        correlationId: "expert-reliability:cp-1",
      }),
    });
  });

  it("charges strikes, not consultee cancels, against the completion rate", () => {
    const counts = [
      { completionStatus: "COMPLETED", outcome: "HELD", _count: 8 },
      { completionStatus: "CANCELLED", outcome: null, _count: 5 },
    ];
    expect(computeConsultantCompletionRate(counts)).toBe(100);
    expect(computeConsultantCompletionRate(counts, 2)).toBe(80);
  });
});
