/**
 * @jest-environment node
 */

/**
 * A declared platform incident voids every session it overlaps, never forfeits
 * or strikes, and makes each learner whole exactly once.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    appointment: { findUnique: jest.fn() },
    appointmentOccurrence: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      updateManyAndReturn: jest.fn(),
    },
    bookingStatusHistory: { create: jest.fn() },
    consultantEarnings: { updateMany: jest.fn() },
    incidentRemedy: {
      createMany: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
      groupBy: jest.fn(),
      count: jest.fn(),
    },
    payment: { findUnique: jest.fn() },
    platformIncident: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      createMany: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    refund: { findFirst: jest.fn(), findMany: jest.fn() },
    systemEvent: { findMany: jest.fn() },
    trial: { findUnique: jest.fn(), updateMany: jest.fn() },
  },
}));
jest.mock("../../lib/booking/session-outcome-sweep", () => ({
  flushClassVoidNotices: jest.fn(),
}));
jest.mock("../../lib/booking/class-sessions", () => ({
  onClassSessionVoided: jest.fn(async () => null),
}));
const stampRefundOwed = jest.fn();
const driveRefundOwed = jest.fn();
jest.mock("../../lib/payments/operations/refund-owed", () => ({
  REFUND_OWED_SELECT: { id: true, refundOwedKey: true, refundOwedPaise: true },
  markerFromRow: (row: {
    id: string;
    refundOwedKey: string | null;
    refundOwedPaise: number | null;
  }) =>
    row.refundOwedKey
      ? {
          paymentId: row.id,
          amountPaise: row.refundOwedPaise,
          key: row.refundOwedKey,
          reason: "refund owed",
        }
      : null,
  stampRefundOwed: (...a: unknown[]) => stampRefundOwed(...a),
  driveRefundOwed: (...a: unknown[]) => driveRefundOwed(...a),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  findDedupedRefund: jest.fn(async () => null),
}));
const stageDigest = jest.fn(async () => [{ staged: { id: "e1" } }]);
jest.mock("../../lib/email/senders/incident", () => ({
  PLATFORM_INCIDENT_DIGEST: "PLATFORM_INCIDENT_DIGEST",
  stagePlatformIncidentDigest: (...a: unknown[]) => stageDigest(...(a as [])),
}));
jest.mock("../../lib/email/send-to-recipients", () => ({
  attemptStaged: jest.fn(),
}));
const stageEmail = jest.fn(async () => ({ id: "r1", idempotencyKey: "k" }));
jest.mock("../../lib/email/deliver", () => ({
  stage: (...a: unknown[]) => stageEmail(...(a as [])),
  attempt: jest.fn(),
}));
jest.mock("../../lib/observability/ingest-alert", () => ({
  canaryAlertRecipient: () => "ops@example.test",
}));
const postOpsChat = jest.fn();
jest.mock("../../lib/observability/ops-chat", () => ({
  postOpsChat: (...a: unknown[]) => postOpsChat(...a),
}));
const withOpsAction = jest.fn((..._args: unknown[]) => jest.fn());
jest.mock("../../lib/backoffice/ops-action-log", () => ({
  withOpsAction: (...a: unknown[]) => withOpsAction(...a),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(),
}));

import { classifySessionOutcome } from "@/lib/booking/session-outcome";
import {
  declareIncident,
  incidentWindowSchema,
  remedyRowsFor,
  voidForIncident,
  type RetroOccurrence,
} from "@/lib/booking/platform-incidents";
import { refundIncidentSeat } from "@/lib/payments/operations/incident-refunds";
import {
  sendIncidentDigests,
  stageAndSendIncidentReport,
} from "@/lib/booking/platform-incident-notices";
import { countExpertStrikes } from "@/lib/booking/expert-reliability";
import { occurrenceRefundsPaise } from "@/lib/booking/class-series";
import { voidRefundExists } from "@/lib/backoffice/session-outcomes";
import { BACKOFFICE_PERMISSIONS } from "@/lib/auth/backoffice-permissions";
import { suggestIncidentWindows } from "@/lib/backoffice/incidents-read";
import prisma from "@/lib/prisma";

type Fn = jest.Mock;
const db = prisma as unknown as {
  $transaction: Fn;
  appointment: Record<"findUnique", Fn>;
  appointmentOccurrence: Record<
    "findMany" | "updateMany" | "updateManyAndReturn",
    Fn
  >;
  consultantEarnings: Record<"updateMany", Fn>;
  incidentRemedy: Record<
    "createMany" | "updateMany" | "findMany" | "groupBy" | "count",
    Fn
  >;
  payment: Record<"findUnique", Fn>;
  platformIncident: Record<
    | "findUnique"
    | "findUniqueOrThrow"
    | "createMany"
    | "findMany"
    | "updateMany",
    Fn
  >;
  refund: Record<"findFirst" | "findMany", Fn>;
  trial: Record<"findUnique" | "updateMany", Fn>;
};

const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 10, 0) + m * 60_000);
const NOW = at(24 * 60);
const incident = {
  startsAt: at(-30),
  endsAt: at(90),
  source: "incident" as const,
};
const maintenance = { ...incident, source: "maintenance" as const };
const classify = (
  intervals: { userId: string; joinedAt: Date; leftAt: Date }[],
  windows: (typeof incident | typeof maintenance)[],
) =>
  classifySessionOutcome({
    startsAt: at(0),
    endsAt: at(60),
    hostUserIds: ["host"],
    intervals,
    meeting: { endedAt: at(60), endedReason: "session_timeout" },
    maintenanceWindows: windows,
  }).outcome;
const learnerOnly = [{ userId: "l", joinedAt: at(0), leftAt: at(60) }];

beforeEach(() => {
  jest.clearAllMocks();
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
});

describe("the classifier", () => {
  it("voids an incident session nobody could join, or the host could not reach", () => {
    expect(classify([], [incident])).toBe("PLATFORM_OUTAGE");
    expect(classify(learnerOnly, [incident])).toBe("PLATFORM_OUTAGE");
  });

  it("keeps maintenance and no-window verdicts as they were", () => {
    expect(classify(learnerOnly, [maintenance])).toBe("INCONCLUSIVE");
    expect(classify([], [maintenance])).toBe("NOBODY_JOINED");
    expect(classify(learnerOnly, [])).toBe("HOST_ABSENT");
  });
});

describe("the declare door", () => {
  const parse = (startsAt: Date, endsAt: Date) =>
    incidentWindowSchema(NOW).safeParse({ startsAt, endsAt }).success;

  it("accepts only a past window inside 7 days and 24 hours", () => {
    expect(parse(at(0), at(60))).toBe(true);
    expect(parse(at(60), at(0))).toBe(false);
    expect(parse(at(0), at(25 * 60))).toBe(false);
    expect(parse(at(-26 * 60), at(-1))).toBe(false);
    expect(parse(at(-8 * 24 * 60), at(-8 * 24 * 60 + 60))).toBe(false);
  });

  it("returns the first incident for an exact duplicate window", async () => {
    db.platformIncident.createMany.mockResolvedValueOnce({ count: 0 });
    db.platformIncident.findUniqueOrThrow.mockResolvedValueOnce({
      id: "inc-1",
    });
    await expect(
      declareIncident(db as never, {
        startsAt: at(0),
        endsAt: at(60),
        reason: "Stream down",
        declaredByUserId: "admin-1",
      }),
    ).resolves.toEqual({ id: "inc-1", created: false });
    expect(db.platformIncident.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  it("is admin-only behind a fresh session, and staff may read", async () => {
    await import("@/app/api/admin/incidents/route");
    expect(withOpsAction).toHaveBeenCalledWith(
      "incidents.declare",
      "incident.declare",
      expect.any(Object),
      expect.objectContaining({ mode: "tx" }),
      { stepUp: true },
    );
    expect([...BACKOFFICE_PERMISSIONS["incidents.declare"]]).toEqual(["ADMIN"]);
    expect(BACKOFFICE_PERMISSIONS["incidents.read"].has("STAFF")).toBe(true);
  });
});

function occ(
  appointment: Partial<RetroOccurrence["appointment"]>,
  over: Partial<RetroOccurrence> = {},
): RetroOccurrence {
  return {
    id: "occ-1",
    appointmentId: "appt-1",
    startsAt: at(0),
    endsAt: at(60),
    completionStatus: "COMPLETED",
    outcome: "HELD",
    seatsSettledAt: null,
    ...over,
    appointment: {
      organizationId: null,
      consultationId: null,
      subscriptionId: null,
      classId: null,
      webinarId: null,
      trial: null,
      subscription: null,
      class: null,
      participants: [{ userId: "u1", paymentId: "pay-1", createdAt: at(-60) }],
      payment: [{ id: "pay-1", userId: "u1" }],
      ...appointment,
    },
  };
}

type StrikeFixture = {
  appointmentId: string;
  occurrenceIds?: string[];
};

function strikeReader(opts: {
  strikes: StrikeFixture[];
  appointmentsInIncident?: string[];
  occurrencesInIncident?: Array<{ id: string; appointmentId: string }>;
}) {
  return {
    systemEvent: {
      findMany: jest.fn(async () =>
        opts.strikes.map(({ appointmentId, occurrenceIds }) => ({
          context: occurrenceIds?.length
            ? { appointmentId, occurrenceIds }
            : { appointmentId },
        })),
      ),
    },
    platformIncident: {
      findMany: jest.fn(async () => [{ startsAt: at(0), endsAt: at(60) }]),
    },
    appointmentOccurrence: {
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: {
            AND?: Array<{
              OR?: Array<{
                id?: { in: string[] };
                appointmentId?: { in: string[] };
              }>;
            }>;
          };
        }) => {
          const scope = where.AND?.[0]?.OR ?? [];
          const rows = [
            ...(opts.occurrencesInIncident ?? []),
            ...(opts.appointmentsInIncident ?? []).map((appointmentId) => ({
              id: `${appointmentId}-occ`,
              appointmentId,
            })),
          ];
          return rows.filter((row) =>
            scope.some(
              (clause) =>
                clause.id?.in.includes(row.id) ||
                clause.appointmentId?.in.includes(row.appointmentId),
            ),
          );
        },
      ),
    },
  };
}

function strikeCount(reader: ReturnType<typeof strikeReader>) {
  return countExpertStrikes("cp-1", at(-60), { db: reader as never });
}

describe("remedy rows", () => {
  it.each([
    [{ consultationId: "c" }, "REFUND_AT_DUE", 48 * 60],
    [{ trial: { id: "t", paymentId: "pay-1" } }, "REFUND_AT_DUE", 48 * 60],
    [{ trial: { id: "t", paymentId: null } }, "TRIAL_REOFFER", 0],
    [{ subscriptionId: "s" }, "SUBSCRIPTION_EXTEND", 0],
    [{ classId: "k" }, "CLASS_EXISTING", 0],
    [{ webinarId: "w" }, "REFUND_NOW", 0],
  ])("%j owes %s", (appointment, kind, dueMinutes) => {
    const [row] = remedyRowsFor(occ(appointment), "inc-1", at(0));
    expect(row).toMatchObject({ kind, userId: "u1", occurrenceId: "occ-1" });
    expect(row.dueAt).toEqual(at(dueMinutes));
  });

  it("skips a seat bought after the session started", () => {
    const late = occ({
      webinarId: "w",
      participants: [{ userId: "u1", paymentId: "pay-1", createdAt: at(5) }],
    });
    expect(remedyRowsFor(late, "inc-1", at(0))).toEqual([]);
  });
});

describe("the retroactive void", () => {
  it("moves a held session to VOIDED by CAS and writes its remedy in the same commit", async () => {
    db.refund.findFirst.mockResolvedValue(null);
    db.appointmentOccurrence.findMany.mockResolvedValue([
      { id: "occ-1", completionStatus: "COMPLETED" },
    ]);
    db.appointmentOccurrence.updateManyAndReturn.mockResolvedValue([
      { id: "occ-1", appointmentId: "appt-1" },
    ]);
    db.incidentRemedy.createMany.mockResolvedValue({ count: 1 });

    const out = await voidForIncident(occ({ webinarId: "w" }), "inc-1", NOW);

    expect(out).toEqual({ outcome: "voided", created: 1 });
    expect(db.appointmentOccurrence.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          completionStatus: { in: ["COMPLETED"] },
        }),
        data: expect.objectContaining({
          completionStatus: "VOIDED",
          outcome: "PLATFORM_OUTAGE",
          // A confirmed absence it replaces does not stay confirmed.
          outcomeConfirmedAt: null,
        }),
      }),
    );
  });

  it("un-stamps the tranche a live plan's voided session un-delivers, in the void's commit", async () => {
    db.refund.findFirst.mockResolvedValue(null);
    db.appointmentOccurrence.findMany.mockResolvedValue([
      { id: "occ-1", completionStatus: "COMPLETED" },
    ]);
    db.appointmentOccurrence.updateManyAndReturn.mockResolvedValue([
      { id: "occ-1", appointmentId: "appt-1" },
    ]);
    db.incidentRemedy.createMany.mockResolvedValue({ count: 1 });
    db.consultantEarnings.updateMany.mockResolvedValue({ count: 1 });
    // 12 sessions at 4 a week: the void leaves 3 of the first cycle's 4 delivered.
    const session = (completionStatus: string, i: number) => ({
      startsAt: at(i * 24 * 60),
      endsAt: at(i * 24 * 60 + 60),
      completionStatus,
      isTentative: false,
      deletedAt: null,
    });
    db.appointment.findUnique.mockResolvedValue({
      payment: [{ id: "pay-1" }],
      subscription: {
        status: "APPROVED",
        sessionsTotal: 12,
        sessionsPerWeek: 4,
        sessionsRefunded: 0,
        schedulingPeriodStartsAt: at(0),
        schedulingTimezone: "UTC",
        planEndsAt: null,
        subscriptionPlan: {
          totalSessions: 12,
          sessionsPerWeek: 4,
          durationInMonths: 3,
        },
      },
      occurrences: ["VOIDED", "COMPLETED", "COMPLETED", "COMPLETED"].map(
        session,
      ),
    });
    const livePlan = occ({
      subscriptionId: "s",
      subscription: {
        status: "APPROVED",
        sessionsTotal: 12,
        subscriptionPlan: { totalSessions: 12 },
      },
    });

    const out = await voidForIncident(livePlan, "inc-1", NOW);

    expect(out.outcome).toBe("voided");
    expect(db.consultantEarnings.updateMany).toHaveBeenCalledWith({
      where: {
        paymentId: { in: ["pay-1"] },
        cycleOrdinal: { gt: -1 },
        holdUntil: { not: null },
        OR: [
          { status: { in: ["PENDING", "PENDING_TRUST"] } },
          {
            status: "HELD",
            preHoldStatus: { in: ["PENDING", "PENDING_TRUST"] },
          },
        ],
      },
      data: { holdUntil: null },
    });
  });

  it("relabels a host-blamed void as the platform's miss and clears its confirmation", async () => {
    db.refund.findFirst.mockResolvedValue(null);
    db.appointmentOccurrence.updateMany.mockResolvedValue({ count: 1 });
    db.incidentRemedy.createMany.mockResolvedValue({ count: 1 });
    const voided = occ(
      { webinarId: "w" },
      { completionStatus: "VOIDED", outcome: "HOST_ABSENT" },
    );

    const out = await voidForIncident(voided, "inc-1", NOW);

    expect(out.outcome).toBe("relabelled");
    expect(db.appointmentOccurrence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ outcome: "HOST_ABSENT" }),
        data: {
          outcome: "PLATFORM_OUTAGE",
          outcomeAt: NOW,
          outcomeConfirmedAt: null,
        },
      }),
    );
  });

  it("loses a racing write cleanly: no remedy rows", async () => {
    db.appointmentOccurrence.findMany.mockResolvedValue([]);
    db.appointmentOccurrence.updateManyAndReturn.mockResolvedValue([]);

    const out = await voidForIncident(occ({ webinarId: "w" }), "inc-1", NOW);

    expect(out.outcome).toBe("lost");
    expect(db.incidentRemedy.createMany).not.toHaveBeenCalled();
  });

  it("skips a void that already carries a refund", async () => {
    db.refund.findFirst.mockResolvedValue({ id: "r1" });
    const voided = occ(
      { consultationId: "c" },
      { completionStatus: "VOIDED", outcome: "CUT_SHORT" },
    );
    await expect(voidForIncident(voided, "inc-1", NOW)).resolves.toEqual({
      outcome: "skipped",
      created: 0,
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("the incident refund", () => {
  it("stamps and drives a full refund under the incident key, freeing a paid trial", async () => {
    stampRefundOwed.mockResolvedValue(true);
    db.trial.findUnique.mockResolvedValue({ status: "SCHEDULED" });
    db.trial.updateMany.mockResolvedValue({ count: 1 });
    driveRefundOwed.mockResolvedValue({
      kind: "refunded",
      refund: { refundId: "r1", amountRefundedPaise: 50_000 },
    });

    const out = await refundIncidentSeat({
      incidentId: "inc-1",
      occurrenceId: "occ-1",
      userId: "u1",
      paymentId: "pay-1",
      trialId: "t1",
    });

    expect(out).toEqual({ kind: "done", refundedPaise: 50_000 });
    const marker = {
      paymentId: "pay-1",
      amountPaise: null,
      key: "incident:inc-1:occ-1:u1",
    };
    expect(stampRefundOwed).toHaveBeenCalledWith(
      db,
      expect.objectContaining(marker),
    );
    expect(driveRefundOwed).toHaveBeenCalledWith(
      expect.objectContaining(marker),
      { initiatedByUserId: null },
    );
    expect(db.trial.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["SCHEDULED", "COMPLETED"] },
        }),
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
  });

  it("never overwrites another door's marker", async () => {
    stampRefundOwed.mockResolvedValue(false);
    db.payment.findUnique.mockResolvedValue({
      refundOwedKey: "trial-cancel:t1:pay-1",
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
    });

    const out = await refundIncidentSeat({
      incidentId: "inc-1",
      occurrenceId: "occ-1",
      userId: "u1",
      paymentId: "pay-1",
      trialId: null,
    });

    expect(out).toEqual({
      kind: "conflict",
      heldKey: "trial-cancel:t1:pay-1",
    });
    expect(driveRefundOwed).not.toHaveBeenCalled();
  });
});

describe("notices", () => {
  it("sends one digest per learner across two runs and two sessions", async () => {
    db.incidentRemedy.findMany
      .mockResolvedValueOnce([{ userId: "u1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    db.incidentRemedy.count.mockResolvedValue(0);
    db.incidentRemedy.updateMany.mockResolvedValueOnce({ count: 2 });
    const opts = { limit: 10, pastDeadline: () => false };

    expect(await sendIncidentDigests("inc-1", opts)).toBe(1);
    expect(await sendIncidentDigests("inc-1", opts)).toBe(0);
    expect(stageDigest).toHaveBeenCalledTimes(1);
  });

  it("holds a learner's digest until their due-now remedies are applied", async () => {
    db.incidentRemedy.findMany.mockResolvedValueOnce([{ userId: "u1" }]);
    db.incidentRemedy.count.mockResolvedValueOnce(1);
    const opts = { limit: 10, pastDeadline: () => false };
    expect(await sendIncidentDigests("inc-1", opts)).toBe(0);
    expect(db.incidentRemedy.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: "u1",
        doneAt: null,
        kind: { not: "REFUND_AT_DUE" },
      }),
    });
    expect(db.incidentRemedy.updateMany).not.toHaveBeenCalled();
  });

  it("stages the ops report once, with its reportedAt stamp", async () => {
    db.platformIncident.findUnique.mockResolvedValue({
      id: "inc-1",
      startsAt: at(0),
      endsAt: at(60),
      reason: "Stream down",
    });
    db.platformIncident.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    db.incidentRemedy.groupBy
      .mockResolvedValueOnce([{ kind: "REFUND_AT_DUE", _count: { _all: 2 } }])
      .mockResolvedValueOnce([{ occurrenceId: "o1" }, { occurrenceId: "o2" }]);
    db.incidentRemedy.count.mockResolvedValue(0);

    expect(await stageAndSendIncidentReport("inc-1")).toBe(1);
    expect(await stageAndSendIncidentReport("inc-1")).toBe(0);
    expect(stageEmail).toHaveBeenCalledTimes(1);
    expect(postOpsChat).toHaveBeenCalledTimes(1);
  });
});

describe("readers that must count incident refunds and skip incident strikes", () => {
  it("counts incident refunds in a payment's per-session refunds", async () => {
    db.refund.findMany.mockResolvedValue([
      {
        paymentId: "pay-1",
        dedupeKey: "incident:inc-1:o1:u1",
        amountPaise: BigInt(10_000),
      },
    ]);
    await expect(occurrenceRefundsPaise(db as never, "pay-1")).resolves.toBe(
      10_000,
    );
    expect(db.refund.findMany.mock.calls[0][0].where.OR).toContainEqual({
      dedupeKey: { startsWith: "incident:" },
    });
  });

  it("treats an incident refund as one that blocks an un-void", async () => {
    db.refund.findFirst.mockResolvedValue({ id: "r1" });
    await expect(voidRefundExists(db as never, "occ-1")).resolves.toBe(true);
    expect(db.refund.findFirst.mock.calls[0][0].where.OR).toContainEqual({
      dedupeKey: { startsWith: "incident:", contains: ":occ-1:" },
    });
  });

  it("drops a strike whose session sat inside a declared incident", async () => {
    const reader = strikeReader({
      strikes: ["a", "b", "c"].map((appointmentId) => ({ appointmentId })),
      appointmentsInIncident: ["b"],
    });
    await expect(strikeCount(reader)).resolves.toBe(2);
  });

  it("counts a rebooked-session strike when only the appointment's other occurrence overlapped", async () => {
    const reader = strikeReader({
      strikes: [{ appointmentId: "a", occurrenceIds: ["occ-new"] }],
      occurrencesInIncident: [{ id: "occ-old", appointmentId: "a" }],
    });
    await expect(strikeCount(reader)).resolves.toBe(1);
  });

  it("drops a strike whose own rebooked occurrence overlapped the incident", async () => {
    const reader = strikeReader({
      strikes: [{ appointmentId: "a", occurrenceIds: ["occ-new"] }],
      appointmentsInIncident: ["a"],
      occurrencesInIncident: [{ id: "occ-new", appointmentId: "a" }],
    });
    await expect(strikeCount(reader)).resolves.toBe(0);
  });

  it("suggests only an hour clearly above the weekly baseline", () => {
    const spike = Array.from({ length: 6 }, (_, i) => at(i));
    const noise = [at(-3 * 60), at(-5 * 60)];
    const windows = suggestIncidentWindows([...spike, ...noise], NOW);
    expect(windows).toEqual([
      {
        startsAt: at(0).toISOString(),
        endsAt: at(60).toISOString(),
        signals: 6,
      },
    ]);
  });
});
