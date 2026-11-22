/**
 * @jest-environment node
 */

/**
 * The platform reschedule door: the only way a STAFF or ADMIN who is not a
 * party moves a booking. It runs the real participant reschedule route under
 * a one-request grant, so the lock, the CAS transitions and the notices are
 * that route's own; only the external edges are mocked here.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/api/after-safe", () => ({
  scheduleAfter: (fn: () => unknown) => fn(),
}));
jest.mock("next/headers", () => ({ headers: async () => new Headers() }));
jest.mock("../../lib/auth-server", () => ({ getSession: jest.fn() }));

const mockMaintenance = { phase: "OFF", unreadable: false as boolean };
jest.mock("../../lib/maintenance-edge", () => ({
  getMaintenanceState: async () => ({
    phase: mockMaintenance.phase,
    reason: null,
    estimatedEnd: null,
    bypassSecret: null,
    ...(mockMaintenance.unreadable ? { unreadable: true } : {}),
  }),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
  rescheduleAppointmentLimiter: {},
}));
jest.mock("../../utils/appointmentlock", () => {
  class AppointmentBusyError extends Error {
    readonly code = "APPOINTMENT_BUSY";
    readonly httpStatus = 409;
  }
  return {
    __esModule: true,
    withAppointmentLock: jest.fn(
      async (_id: string, fn: () => Promise<unknown>) => fn(),
    ),
    renewAppointmentLock: jest.fn(async () => undefined),
    BookingLockUnavailableError: class extends Error {},
    AppointmentBusyError,
  };
});

// External edges: Novu bells, booking email, the activity feed, collaborators.
jest.mock("../../lib/novu/service", () => ({
  notifyAppointmentRescheduled: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../lib/email/senders/booking", () => ({
  stageAppointmentRescheduledEmail: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/collaborators/recipients", () => ({
  collaboratorUserIds: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../lib/booking/reschedule-auto-confirm", () => ({
  tryAutoConfirmProposal: jest.fn(),
}));
jest.mock("../../lib/booking/org-actor", () => ({
  resolveOrgActor: jest.fn().mockResolvedValue(null),
  recordActForOrg: jest.fn(),
}));
jest.mock("../../lib/enterprise/suspended-member-sessions", () => ({
  isSuspendedInFundingOrg: jest.fn().mockResolvedValue(false),
  membershipSuspendedError: () => new Error("suspended"),
}));

const mockOpsRows: Record<string, unknown>[] = [];
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    appointment: { findUnique: jest.fn() },
    dispute: { findFirst: jest.fn().mockResolvedValue(null) },
    membership: { findUnique: jest.fn().mockResolvedValue(null) },
    opsActionLog: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        mockOpsRows.push(data);
        return { id: "log" };
      }),
    },
  },
}));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { notifyAppointmentRescheduled } from "@/lib/novu/service";
import {
  AppointmentBusyError,
  withAppointmentLock,
} from "@/utils/appointmentlock";
import { POST as platformReschedule } from "@/app/api/staff/appointments/[appointmentId]/reschedule/route";

const APPT = "8b2f6c1e-1d2a-4f3b-9c4d-5e6f7a8b9c0d";
const IN_TWO_DAYS = new Date(Date.now() + 48 * 60 * 60 * 1000);
const IN_THREE_DAYS = new Date(Date.now() + 72 * 60 * 60 * 1000);
const REASON = "Expert asked support to move the session";

type Viewer = { id: string; role: string; twoFactorEnabled: boolean };
const viewer: Viewer = { id: "staff-1", role: "STAFF", twoFactorEnabled: true };
let sessionCreatedAt = new Date();

function slot(id: string, startsAt: Date) {
  return {
    id,
    appointmentId: APPT,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
    isTentative: false,
    completionStatus: "SCHEDULED",
  };
}

function consultationAppointment(startsAt = IN_TWO_DAYS) {
  return {
    id: APPT,
    appointmentType: "CONSULTATION",
    organizationId: null,
    occurrences: [slot("slot-1", startsAt)],
    participants: [],
    consultation: {
      id: "cons-1",
      status: "APPROVED",
      consultationPlan: {
        title: "Career review",
        consultantProfileId: "cp-001",
        consultantProfile: {
          userId: "expert-user",
          user: { name: "Dr. Smith" },
        },
      },
      requestedById: "ce-001",
      requestedBy: { userId: "learner-user", user: { name: "John Doe" } },
    },
    subscription: null,
    webinar: null,
    class: null,
  };
}

function subscriptionAppointment() {
  return {
    ...consultationAppointment(),
    appointmentType: "SUBSCRIPTION",
    occurrences: [slot("slot-1", IN_TWO_DAYS), slot("slot-2", IN_THREE_DAYS)],
    consultation: null,
    subscription: {
      id: "sub-1",
      status: "APPROVED",
      subscriptionPlan: consultationAppointment().consultation.consultationPlan,
      requestedById: "ce-001",
      requestedBy: { userId: "learner-user", user: { name: "John Doe" } },
    },
  };
}

function makeMockTx(appointment: unknown) {
  return {
    appointment: { findUnique: jest.fn().mockResolvedValue(appointment) },
    consultation: {
      findUnique: jest.fn().mockResolvedValue({ status: "APPROVED" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    subscription: {
      findUnique: jest.fn().mockResolvedValue({ status: "APPROVED" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    appointmentOccurrence: {
      findMany: jest.fn().mockResolvedValue([]),
      updateManyAndReturn: jest.fn().mockResolvedValue([{ id: "slot-1" }]),
    },
    bookingStatusHistory: {
      create: jest.fn().mockResolvedValue({}),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    rescheduleRequest: {
      create: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    payment: { count: jest.fn().mockResolvedValue(0) },
  };
}

let tx: ReturnType<typeof makeMockTx>;

function useAppointment(appointment: unknown) {
  (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(appointment);
  tx = makeMockTx(appointment);
  (prisma.$transaction as jest.Mock).mockImplementation(
    async (fn: (t: unknown) => unknown) => fn(tx),
  );
}

function post(body: Record<string, unknown> = { reason: REASON }) {
  return platformReschedule(
    new NextRequest(
      `https://x.test/api/staff/appointments/${APPT}/reschedule`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ appointmentId: APPT }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOpsRows.length = 0;
  mockMaintenance.phase = "OFF";
  mockMaintenance.unreadable = false;
  viewer.id = "staff-1";
  viewer.role = "STAFF";
  viewer.twoFactorEnabled = true;
  sessionCreatedAt = new Date();
  (getSession as jest.Mock).mockImplementation(async () => ({
    user: {
      id: viewer.id,
      name: "Operator",
      role: viewer.role,
      twoFactorEnabled: viewer.twoFactorEnabled,
      consultantProfileId: null,
      consulteeProfileId: null,
    },
    session: { createdAt: sessionCreatedAt },
  }));
  useAppointment(consultationAppointment());
});

describe("platform reschedule door — authorization", () => {
  it.each([["STAFF"], ["ADMIN"]])(
    "lets %s release a booking they are not a party to",
    async (role) => {
      viewer.id = `${role.toLowerCase()}-1`;
      viewer.role = role;
      const res = await post();
      expect(res.status).toBe(200);
      expect(tx.appointmentOccurrence.updateManyAndReturn).toHaveBeenCalled();
    },
  );

  it.each([["CONSULTANT"], ["CONSULTEE"]])(
    "refuses a %s before the booking is read",
    async (role) => {
      viewer.role = role;
      const res = await post();
      expect(res.status).toBe(403);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(mockOpsRows).toHaveLength(0);
    },
  );

  it("answers 428 to an operator without two-factor authentication", async () => {
    viewer.twoFactorEnabled = false;
    const res = await post();
    expect(res.status).toBe(428);
    expect((await res.json()).code).toBe("TWO_FACTOR_REQUIRED");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("asks a stale session to re-authenticate first", async () => {
    sessionCreatedAt = new Date(Date.now() - 60 * 60 * 1000);
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("REAUTH_REQUIRED");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mockOpsRows).toHaveLength(0);
  });

  it("requires a reason", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_BODY");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("platform reschedule door — the shared reschedule path", () => {
  it("releases the booking through the CAS helpers, notifies both parties and audits before and after", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.opsActionId).toEqual(expect.any(String));
    expect(json.data).toMatchObject({
      success: true,
      rescheduleType: "entire_booking",
      slotsMoved: 1,
    });

    expect(withAppointmentLock).toHaveBeenCalledWith(
      APPT,
      expect.any(Function),
    );
    expect(tx.consultation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "cons-1" }),
        data: expect.objectContaining({ status: "PENDING" }),
      }),
    );
    expect(tx.bookingStatusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorUserId: "staff-1",
          reason: REASON,
        }),
      }),
    );
    // An operator is neither party, so no proposal opens on anyone's behalf.
    expect(tx.rescheduleRequest.create).not.toHaveBeenCalled();
    expect(notifyAppointmentRescheduled).toHaveBeenCalledWith(
      expect.arrayContaining(["expert-user", "learner-user"]),
      expect.anything(),
      expect.anything(),
    );

    expect(mockOpsRows).toEqual([
      expect.objectContaining({
        id: json.opsActionId,
        actorUserId: "staff-1",
        actorRole: "STAFF",
        surface: "appointments.manage",
        action: "appointment.reschedule.platform",
        targetKind: "Appointment",
        targetId: APPT,
        reason: REASON,
        before: {
          appointmentType: "CONSULTATION",
          status: "APPROVED",
          sessions: [
            {
              id: "slot-1",
              startsAt: IN_TWO_DAYS.toISOString(),
              endsAt: new Date(
                IN_TWO_DAYS.getTime() + 30 * 60 * 1000,
              ).toISOString(),
              completionStatus: "SCHEDULED",
            },
          ],
        },
        after: expect.objectContaining({
          status: "SUCCEEDED",
          slotIds: null,
          rescheduleType: "entire_booking",
          slotsMoved: 1,
        }),
      }),
    ]);
  });

  it("releases only the named session of a subscription", async () => {
    useAppointment(subscriptionAppointment());
    tx.appointmentOccurrence.updateManyAndReturn.mockResolvedValue([
      { id: "slot-2" },
    ]);
    const res = await post({ reason: REASON, slotIds: ["slot-2"] });
    expect(res.status).toBe(200);
    expect(tx.appointmentOccurrence.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["slot-2"] } }),
      }),
    );
    // A partial release leaves the plan's own status alone.
    expect(tx.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { updatedAt: expect.any(Date) } }),
    );
    expect(mockOpsRows[0]).toMatchObject({
      after: { status: "SUCCEEDED", slotIds: ["slot-2"], sessionsAffected: 1 },
    });
  });

  it("relays a lost CAS as the route's 409 and logs the attempt as failed", async () => {
    tx.consultation.updateMany.mockResolvedValue({ count: 0 });
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_RESCHEDULABLE");
    expect(notifyAppointmentRescheduled).not.toHaveBeenCalled();
    expect(mockOpsRows).toEqual([
      expect.objectContaining({
        action: "appointment.reschedule.platform",
        after: { status: "FAILED", code: "NOT_RESCHEDULABLE" },
      }),
    ]);
  });

  it("relays a busy appointment lock rather than racing another writer", async () => {
    (withAppointmentLock as jest.Mock).mockRejectedValueOnce(
      new AppointmentBusyError("busy"),
    );
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("APPOINTMENT_BUSY");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("keeps the participant route's 24-hour window for operators too", async () => {
    useAppointment(
      consultationAppointment(new Date(Date.now() + 2 * 60 * 60 * 1000)),
    );
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("RESCHEDULE_WINDOW");
    expect(tx.appointmentOccurrence.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown booking without opening a transaction", async () => {
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("platform reschedule door — maintenance", () => {
  it.each([
    ["DEGRADED", false, "MAINTENANCE"],
    ["OFFLINE", false, "MAINTENANCE"],
    ["OFF", true, "MAINTENANCE_UNKNOWN"],
  ])(
    "refuses in %s (unreadable=%s) before the booking moves",
    async (phase, unreadable, code) => {
      mockMaintenance.phase = phase;
      mockMaintenance.unreadable = unreadable;
      const res = await post();
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe(code);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(mockOpsRows).toEqual([
        expect.objectContaining({ after: { status: "FAILED", code } }),
      ]);
    },
  );
});
