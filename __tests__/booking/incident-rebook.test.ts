/**
 * @jest-environment node
 */

/**
 * The free rebook of an outage-voided 1:1: typed refusals, the shared slot
 * validator, a refund that landed first wins, refund-now is idempotent, a paid
 * trial reopens, the payment's one earning is never re-minted, and the digest copy.
 */

type Parent = "consultation" | "trial";

const HOUR = 3_600_000;
const state = {
  remedy: {} as Record<string, unknown>,
  occ: { completionStatus: "VOIDED", seatsSettledAt: null as Date | null },
  parentStatus: "SCHEDULED",
  refundOwedKey: null as string | null,
  overlap: false,
  buyerProfileId: null as string | null,
};

// The database's host-time locks are pinned in host-time-locks.test.ts.
jest.mock("../../lib/booking/allocation/host-time-locks", () => ({
  lockHostTimeInTx: jest.fn(async () => undefined),
}));
jest.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {
    incidentRemedy: {
      findUnique: jest.fn(async () => ({ ...state.remedy })),
      findUniqueOrThrow: jest.fn(async () => ({ ...state.remedy })),
      updateMany: jest.fn(async ({ where, data }) => {
        const r = state.remedy as { doneAt: Date | null; dueAt: Date };
        const open = where.doneAt === null ? r.doneAt === null : true;
        if (!open || !(r.dueAt > where.dueAt.gt)) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }) => Object.assign(state.remedy, data)),
    },
    appointmentOccurrence: {
      updateMany: jest.fn(async ({ data }) => {
        if (state.occ.completionStatus !== "VOIDED" || state.occ.seatsSettledAt)
          return { count: 0 };
        Object.assign(state.occ, data);
        return { count: 1 };
      }),
      create: jest.fn(async () => {
        if (state.overlap) {
          throw Object.assign(new Error("conflicting key value"), {
            meta: { code: "23P01" },
          });
        }
        return { id: "occ-new" };
      }),
    },
    payment: {
      findUnique: jest.fn(async () => ({
        refundOwedKey: state.refundOwedKey,
      })),
    },
    refund: { findUnique: jest.fn(async () => null) },
    consultantProfile: {
      findUnique: jest.fn(async ({ where }: { where: { userId?: string } }) =>
        where.userId
          ? state.buyerProfileId && { id: state.buyerProfileId }
          : {
              deletedAt: null,
              scheduleType: "WEEKLY",
              user: { id: "expert-user", timezone: "Asia/Kolkata" },
              availabilityWindowsWeekly: [],
              availabilityWindowsCustom: [],
            },
      ),
    },
    trial: {
      findUnique: jest.fn(async () => ({ status: state.parentStatus })),
    },
    consultation: {
      findUnique: jest.fn(async () => ({ status: state.parentStatus })),
    },
    consultantEarnings: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      create: jest.fn(),
      createMany: jest.fn(),
    },
    organizationEarnings: { updateMany: jest.fn(async () => ({ count: 0 })) },
  };
  client.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});
const lockSlotBatch = jest.fn(async (..._a: unknown[]) => []);
jest.mock("../../utils/appointmentlock", () => ({
  requestLockBudget: () => ({}),
  renewConsulteeBooking: jest.fn(async () => undefined),
  ConsulteeBookingBusyError: class extends Error {},
  withAppointmentLock: (_id: string, fn: () => unknown) => fn(),
  lockConsulteeBooking: jest.fn(async () => ({})),
  unlockConsulteeBooking: jest.fn(),
  lockSlotBatch: (...a: unknown[]) => lockSlotBatch(...a),
  unlockSlotInterval: jest.fn(),
}));
const validate = jest.fn();
jest.mock("../../utils/scheduling-engine/ScheduleValidationService", () => ({
  ScheduleValidationService: jest.fn(() => ({ validate })),
}));
const recomputeEarningsHold = jest.fn();
jest.mock("../../lib/payments/payouts/earnings-hold", () => ({
  recomputeEarningsHold: (...a: unknown[]) => recomputeEarningsHold(...a),
}));
const transitionTrial = jest.fn();
const transitionConsultationRequest = jest.fn();
jest.mock("../../lib/booking/transitions", () => ({
  transitionTrial: (...a: unknown[]) => transitionTrial(...a),
  transitionConsultationRequest: (...a: unknown[]) =>
    transitionConsultationRequest(...a),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyAppointmentRescheduled: jest.fn(async () => []),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(),
}));
const stageEmail = jest.fn(async () => []);
jest.mock("../../lib/email/senders/booking", () => ({
  stageAppointmentRescheduledEmail: (...a: unknown[]) =>
    stageEmail(...(a as [])),
}));

import prisma from "../../lib/prisma";
import {
  bringIncidentRefundForward,
  rebookIncidentRemedy,
} from "../../lib/booking/incident-rebook";
import {
  incidentRefundKey,
  isRebookableParent,
} from "../../lib/booking/incident-keys";
import { incidentRemedyText } from "../../lib/email/senders/incident";

const db = prisma as unknown as {
  appointmentOccurrence: { create: jest.Mock };
  consultantEarnings: {
    create: jest.Mock;
    createMany: jest.Mock;
    updateMany: jest.Mock;
  };
};
const person = (id: string, name: string) => ({ user: { id, name } });

function seed(parent: Parent, overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const voidedStart = new Date(now - 24 * HOUR);
  state.occ = { completionStatus: "VOIDED", seatsSettledAt: null };
  // A confirmed 1:1 is stored APPROVED; a confirmed trial is SCHEDULED.
  state.parentStatus = parent === "consultation" ? "APPROVED" : "SCHEDULED";
  state.refundOwedKey = null;
  state.overlap = false;
  state.buyerProfileId = null;
  state.remedy = {
    id: "rem-1",
    incidentId: "inc-1",
    occurrenceId: "occ-void",
    userId: "learner",
    paymentId: "pay-1",
    kind: "REFUND_AT_DUE",
    dueAt: new Date(now + 47 * HOUR),
    doneAt: null,
    rebookedOccurrenceId: null,
    occurrence: {
      appointmentId: "appt-1",
      ordinal: 1,
      startsAt: voidedStart,
      endsAt: new Date(voidedStart.getTime() + HOUR),
      consultantProfileId: "cp-1",
      appointment: {
        organizationId: null,
        consultation:
          parent === "consultation"
            ? {
                id: "cons-1",
                status: "APPROVED",
                requestedBy: person("learner", "Ravi"),
                consultationPlan: {
                  title: "Career chat",
                  consultantProfileId: "cp-1",
                  consultantProfile: person("expert-user", "Asha"),
                },
              }
            : null,
        trial:
          parent === "trial"
            ? {
                id: "trial-1",
                status: "SCHEDULED",
                paymentId: "pay-1",
                consultantProfileId: "cp-1",
                consulteeProfile: person("learner", "Ravi"),
                consultantProfile: person("expert-user", "Asha"),
                subscriptionPlan: { title: "Trial" },
              }
            : null,
      },
    },
    ...overrides,
  };
}

/** Two days out, on the hour. */
const nextSlot = () =>
  new Date(Math.ceil((Date.now() + 48 * HOUR) / HOUR) * HOUR);
const rebook = (userId = "learner", startsAt = nextSlot()) =>
  rebookIncidentRemedy({ remedyId: "rem-1", userId, startsAt });

beforeEach(() => {
  jest.clearAllMocks();
  validate.mockResolvedValue({ isValid: true, errors: [], warnings: [] });
});

describe("the rebook door", () => {
  it("refuses a stranger, a wrong kind, a closed remedy and a past due time", async () => {
    seed("consultation");
    await expect(rebook("someone-else")).rejects.toMatchObject({
      code: "INCIDENT_REMEDY_NOT_FOUND",
      httpStatus: 404,
    });
    seed("consultation", { kind: "REFUND_NOW" });
    await expect(rebook()).rejects.toMatchObject({
      code: "INCIDENT_REMEDY_WRONG_KIND",
    });
    seed("consultation", { doneAt: new Date() });
    await expect(rebook()).rejects.toMatchObject({
      code: "INCIDENT_REMEDY_CLOSED",
    });
    seed("consultation", { dueAt: new Date(Date.now() - 1000) });
    await expect(rebook()).rejects.toMatchObject({
      code: "INCIDENT_REMEDY_CLOSED",
    });
    expect(db.appointmentOccurrence.create).not.toHaveBeenCalled();
  });

  it("runs the consultation validator on both calendars and refuses what it refuses", async () => {
    seed("consultation");
    const startsAt = nextSlot();
    validate.mockResolvedValueOnce({
      isValid: false,
      errors: ["[CONFLICT]"],
      warnings: [],
      conflicts: [{ slot: "x" }],
    });
    await expect(rebook("learner", startsAt)).rejects.toMatchObject({
      code: "INCIDENT_REBOOK_SLOT_UNAVAILABLE",
    });
    expect(validate).toHaveBeenCalledWith(
      "consultation",
      "cons-1",
      [startsAt, new Date(startsAt.getTime() + HOUR / 2)],
      expect.objectContaining({
        userId: "expert-user",
        scheduleType: "WEEKLY",
      }),
      { durationInHours: 1 },
      undefined,
      { consulteeUserId: "learner", consultantProfileId: "cp-1" },
    );
    seed("consultation");
    await expect(
      rebook("learner", new Date(nextSlot().getTime() + 60_000)),
    ).rejects.toMatchObject({ code: "INCIDENT_REBOOK_SLOT_UNAVAILABLE" });
    await expect(
      rebook("learner", new Date(nextSlot().getTime() + 40 * 24 * HOUR)),
    ).rejects.toMatchObject({ code: "INCIDENT_REBOOK_SLOT_UNAVAILABLE" });
  });

  it("answers a host overlap (23P01) with a typed 409", async () => {
    seed("consultation");
    state.overlap = true;
    await expect(rebook()).rejects.toMatchObject({
      code: "SCHEDULE_CONFLICT",
      httpStatus: 409,
    });
  });

  it("loses to an incident refund the sweep already stamped", async () => {
    seed("consultation");
    state.refundOwedKey = incidentRefundKey("inc-1", "occ-void", "learner");
    await expect(rebook()).rejects.toMatchObject({
      code: "INCIDENT_REMEDY_CLOSED",
    });
    expect(db.appointmentOccurrence.create).not.toHaveBeenCalled();
  });
});

describe("a committed rebook", () => {
  it("places the session on the same appointment, settles the void and mints no earning", async () => {
    seed("consultation");
    const result = await rebook();
    expect(result.occurrenceId).toBe("occ-new");
    expect(db.appointmentOccurrence.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          appointmentId: "appt-1",
          ordinal: 1,
          isTentative: false,
          consultantProfileId: "cp-1",
        }),
      }),
    );
    expect(state.remedy).toMatchObject({
      doneAt: expect.any(Date),
      rebookedOccurrenceId: "occ-new",
    });
    expect(state.occ.seatsSettledAt).toBeInstanceOf(Date);
    expect(recomputeEarningsHold).toHaveBeenCalledWith(prisma, "appt-1");
    expect(db.consultantEarnings.create).not.toHaveBeenCalled();
    expect(db.consultantEarnings.createMany).not.toHaveBeenCalled();
    expect(transitionConsultationRequest).not.toHaveBeenCalled();
  });

  it("a completed consultation returns to APPROVED, and a second void of the rebooked session is rebookable again", async () => {
    seed("consultation");
    state.parentStatus = "COMPLETED";
    await rebook();
    expect(transitionConsultationRequest).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        where: { id: "cons-1" },
        to: "APPROVED",
        fromIn: ["COMPLETED"],
      }),
    );
    // The rebooked session is voided too: the reopened booking is APPROVED and takes it.
    seed("consultation");
    transitionConsultationRequest.mockClear();
    await expect(rebook()).resolves.toMatchObject({ occurrenceId: "occ-new" });
    expect(transitionConsultationRequest).not.toHaveBeenCalled();
  });

  it("takes a learner-expert's own atoms in the same batch as the host's", async () => {
    seed("consultation");
    state.buyerProfileId = "cp-buyer";
    await rebook();
    expect(lockSlotBatch).toHaveBeenCalledTimes(1);
    expect(lockSlotBatch.mock.calls[0][0]).toEqual([
      expect.objectContaining({ consultantProfileId: "cp-1" }),
      expect.objectContaining({ consultantProfileId: "cp-buyer" }),
    ]);
  });

  it("reopens a completed paid trial and lets its next completion start the hold again", async () => {
    seed("trial");
    state.parentStatus = "COMPLETED";
    await rebook();
    expect(transitionTrial).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        where: { id: "trial-1" },
        to: "SCHEDULED",
        fromIn: ["COMPLETED"],
        data: { completedAt: null },
      }),
    );
    expect(db.consultantEarnings.updateMany).toHaveBeenCalledWith({
      where: {
        paymentId: "pay-1",
        status: "PENDING",
        holdUntil: { not: null },
      },
      data: { holdUntil: null },
    });
  });
});

describe("refund now", () => {
  it("moves dueAt once and answers a repeat the same way", async () => {
    seed("consultation");
    const first = await bringIncidentRefundForward({
      remedyId: "rem-1",
      userId: "learner",
    });
    const second = await bringIncidentRefundForward({
      remedyId: "rem-1",
      userId: "learner",
    });
    expect(first).toEqual(second);
    expect(first.refunded).toBe(false);
    expect(new Date(first.dueAt).getTime()).toBeLessThanOrEqual(Date.now());
    await expect(rebook()).rejects.toMatchObject({
      code: "INCIDENT_REMEDY_CLOSED",
    });
  });

  it("refuses once the session was rebooked", async () => {
    seed("consultation", {
      doneAt: new Date(),
      rebookedOccurrenceId: "occ-new",
    });
    await expect(
      bringIncidentRefundForward({ remedyId: "rem-1", userId: "learner" }),
    ).rejects.toMatchObject({ code: "INCIDENT_REMEDY_CLOSED" });
  });
});

it("the digest offers the free rebook before the refund date, in the reader's zone", () => {
  const item = {
    kind: "REFUND_AT_DUE" as const,
    appointmentId: "appt-1",
    planTitle: "Career chat",
    expertName: "Asha",
    startsAt: new Date("2026-10-17T04:30:00Z"),
    dueAt: new Date("2026-10-20T06:30:00Z"),
    planEndsAt: null,
    rebookedStartsAt: null,
    rebookable: true,
  };
  expect(incidentRemedyText(item, "Asia/Kolkata")).toMatch(
    /^Rebook free with Asha by .*12:00.*, or we refund 100 % on .*20.*\.$/,
  );
  expect(
    incidentRemedyText(
      { ...item, rebookedStartsAt: new Date("2026-10-22T04:30:00Z") },
      "Asia/Kolkata",
    ),
  ).toMatch(/^You rebooked this session free for /);
  expect(
    incidentRemedyText({ ...item, rebookable: false }, "Asia/Kolkata"),
  ).toMatch(/^You get a full refund on /);
});

describe("who may take the free rebook", () => {
  it("is decided per kind: a 1:1 while APPROVED or COMPLETED, a trial while SCHEDULED or COMPLETED", () => {
    expect(isRebookableParent("consultation", "APPROVED")).toBe(true);
    expect(isRebookableParent("consultation", "COMPLETED")).toBe(true);
    expect(isRebookableParent("consultation", "SCHEDULED")).toBe(false);
    expect(isRebookableParent("consultation", "CANCELLED")).toBe(false);
    expect(isRebookableParent("trial", "SCHEDULED")).toBe(true);
    expect(isRebookableParent("trial", "COMPLETED")).toBe(true);
    expect(isRebookableParent("trial", "APPROVED")).toBe(false);
  });
});
