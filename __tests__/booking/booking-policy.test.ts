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
          planEndsAt: END,
          schedulingPeriodStartsAt: new Date("2026-10-30T00:00:00.000Z"),
          schedulingTimezone: "UTC",
          requestedBy: { user: { name: "Asha" } },
          subscriptionPlan: {
            title: "Weekly",
            durationInMonths: 1,
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
type IdemRow = Record<string, unknown> & { completedAt: Date | null };
const idem = new Map<string, IdemRow>();
const idemKey = (w: { scope_key_userId: Record<string, string> }) =>
  JSON.stringify(w.scope_key_userId);
const idempotencyRecord = {
  create: jest.fn(async ({ data }: { data: Record<string, string> }) => {
    const k = JSON.stringify({
      scope: data.scope,
      key: data.key,
      userId: data.userId,
    });
    if (idem.has(k)) throw Object.assign(new Error("dup"), { code: "P2002" });
    idem.set(k, { ...data, completedAt: null });
    return {};
  }),
  findUnique: jest.fn(async ({ where }: { where: never }) =>
    idem.get(idemKey(where)),
  ),
  update: jest.fn(
    async ({
      where,
      data,
    }: {
      where: never;
      data: Record<string, unknown>;
    }) => {
      const row = idem.get(idemKey(where));
      if (row) Object.assign(row, data);
      return row;
    },
  ),
  delete: jest.fn(async ({ where }: { where: never }) =>
    idem.delete(idemKey(where)),
  ),
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (fn: (t: unknown) => unknown) => fn(tx),
    get idempotencyRecord() {
      return idempotencyRecord;
    },
  },
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({
    session: { user: { id: "u-cee", consulteeProfileId: "cee-1" } },
  }),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  eventMutationLimiter: {},
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
import {
  readOwnStrikes,
  recordExpertStrike,
} from "@/lib/booking/expert-reliability";
import { POST as returnRoute } from "@/app/api/appointments/[appointmentId]/occurrences/[occurrenceId]/return/route";
import { strikeWindowStart } from "@/lib/booking/expert-reliability-rules";
import { NextRequest } from "next/server";

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
        sessionsReturned: 0,
      },
      data: {
        sessionsReturned: { increment: 1 },
        planEndsAt: new Date(END.getTime() + 7 * 24 * HOUR),
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
      sessionsRefunded: 0,
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

describe("the return route", () => {
  const post = () =>
    returnRoute(
      new NextRequest(
        "http://localhost/api/appointments/appt-1/occurrences/occ-1/return",
        {
          method: "POST",
          headers: { "Idempotency-Key": "qa-key-0000001" },
          body: "{}",
        },
      ),
      {
        params: Promise.resolve({
          appointmentId: "appt-1",
          occurrenceId: "occ-1",
        }),
      },
    );

  it("replays the first answer for a repeated Idempotency-Key", async () => {
    idem.clear();
    const first = await post();
    expect(first.status).toBe(200);
    const second = await post();
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotent-Replay")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
    expect(tx.subscription.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("expert reliability strikes", () => {
  it("counts strikes over the last 90 days", () => {
    expect(strikeWindowStart(NOW)).toEqual(
      new Date(NOW.getTime() - 90 * 24 * HOUR),
    );
  });

  it("writes one strike on the expert's correlation, and none for a platform void", async () => {
    const create = jest.fn(async () => ({}));
    const db = { systemEvent: { create } } as never;
    await expect(
      recordExpertStrike(db, {
        consultantProfileId: "cp-1",
        cause: "PLATFORM_VOID",
        appointmentId: "appt-1",
        occurrenceIds: ["occ-1"],
      }),
    ).resolves.toBe(false);
    await recordExpertStrike(db, {
      consultantProfileId: "cp-1",
      cause: "EXPERT_CANCEL",
      appointmentId: "appt-1",
      occurrenceIds: ["occ-1"],
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        correlationId: "expert-reliability:cp-1",
      }),
    });
  });
  it("reads the expert's own record newest first, in the expert's words, with each strike's plan and session", async () => {
    const strike = (
      strike: string,
      at: string,
      context: { appointmentId: string; occurrenceIds?: string[] },
    ) => ({ createdAt: new Date(at), context: { strike, ...context } });
    const titled = (id: string, startsAt: string, title: string) => ({
      id,
      startsAt: new Date(startsAt),
      appointment: {
        id: "appt-1",
        appointmentType: "CONSULTATION",
        consultation: { consultationPlan: { title } },
        subscription: null,
        webinar: null,
        class: null,
        trial: null,
      },
    });
    const occurrences = jest.fn(async () => [
      titled("occ-1", "2026-10-21T04:30:00Z", "Career chat"),
    ]);
    const db = {
      systemEvent: {
        findMany: jest.fn(async () => [
          strike("CONSULTANT_NO_SHOW", "2026-10-30T10:00:00Z", {
            appointmentId: "appt-1",
            occurrenceIds: ["occ-1"],
          }),
          strike("EXPERT_CANCEL", "2026-10-20T10:00:00Z", {
            appointmentId: "appt-2",
          }),
        ]),
      },
      platformIncident: { findMany: jest.fn(async () => []) },
      appointmentOccurrence: { findMany: occurrences },
    } as never;
    await expect(readOwnStrikes("cp-1", { now: NOW, db })).resolves.toEqual({
      windowDays: 90,
      count: 2,
      recent: [
        {
          at: "2026-10-30T10:00:00.000Z",
          cause: "CONSULTANT_NO_SHOW",
          planTitle: "Career chat",
          sessionAt: "2026-10-21T04:30:00.000Z",
        },
        {
          at: "2026-10-20T10:00:00.000Z",
          cause: "EXPERT_CANCEL",
          planTitle: null,
          sessionAt: null,
        },
      ],
    });
    // One batched read for every listed strike's sessions.
    expect(occurrences).toHaveBeenCalledTimes(1);
    expect(occurrences).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["occ-1"] } } }),
    );
  });

  it("records the judged occurrence on a no-show strike", async () => {
    const create = jest.fn(async () => ({}));
    await recordExpertStrike({ systemEvent: { create } } as never, {
      consultantProfileId: "cp-1",
      cause: "CONSULTANT_NO_SHOW",
      appointmentId: "appt-1",
      occurrenceIds: ["occ-new"],
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        context: expect.objectContaining({ occurrenceIds: ["occ-new"] }),
      }),
    });
  });
});
