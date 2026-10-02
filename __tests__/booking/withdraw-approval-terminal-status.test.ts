/**
 * @jest-environment node
 */

/**
 * `lapseApprovedRequest` serves BOTH the lapsed window and the consultant's
 * Withdraw through one body, so the terminal word has to be threaded through
 * rather than hardcoded.
 *
 * A window that ran out is EXPIRED. A consultant deliberately taking back a live,
 * still-payable approval is a party with standing ending a booking — CANCELLED.
 * Reporting the second as EXPIRED put the badge "Expired" on the buyer's request
 * while the notice it had just sent said "The expert withdrew the approval", which
 * is the doctrine's "picking the wrong one is a user-facing lie".
 *
 * Pinned here:
 *  - the two reasons land on different statuses, and neither moves anything the
 *    other could
 *  - the money predicate and the APPROVED_PENDING_PAYMENT from-set still ride the
 *    CAS WHERE on BOTH edges, so a withdrawal can still never reach a paid row
 *  - `CANCELLABLE_FROM` really does contain the state a withdrawal starts from,
 *    so the CANCELLED edge is legal without widening the map
 *  - the route answers the status it wrote
 */

// `@jest-environment node` above: this suite loads `next/server` and the Prisma
// client, so it runs in node rather than jsdom.

jest.mock("../../lib/prisma", () => {
  const db: Record<string, unknown> = {
    consultation: {
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    subscription: {
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    appointment: { findFirst: jest.fn().mockResolvedValue(null) },
    appointmentOccurrence: {
      findMany: jest.fn().mockResolvedValue([]),
      updateManyAndReturn: jest.fn().mockResolvedValue([]),
    },
    payment: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  };
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { __esModule: true, default: db };
});

const lockCalls: string[] = [];
jest.mock("../../utils/appointmentlock", () => ({
  withAppointmentLock: async (id: string, fn: (lock?: unknown) => unknown) => {
    lockCalls.push(id);
    return fn({ key: `appointment-lock:${id}` });
  },
  // #1319 — the route hands the renewal in beside the lock, because the
  // withdraw's retry loop outlives the fixed grant.
  renewAppointmentLock: jest.fn(async () => true),
  AppointmentBusyError: class extends Error {},
  BookingLockUnavailableError: class extends Error {},
}));

const notifyConsulteeRequestExpired = jest.fn().mockResolvedValue(undefined);
jest.mock("../../lib/booking/expiry-notices", () => ({
  notifyConsulteeRequestExpired: (...a: unknown[]) =>
    notifyConsulteeRequestExpired(...(a as [never])),
}));

const session: {
  user: {
    id: string;
    role: string;
    consultantProfileId: string | null;
    consulteeProfileId: string | null;
  };
} = {
  user: {
    id: "u-consultant",
    role: "CONSULTANT",
    consultantProfileId: "cp-1",
    consulteeProfileId: null,
  },
};
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({ session }),
  isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
  forbiddenResponse: (message: string) =>
    new (jest.requireActual("next/server").NextResponse)(
      JSON.stringify({ error: message }),
      { status: 403 },
    ),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  eventMutationLimiter: {},
}));

import prisma from "../../lib/prisma";
import { lapseApprovedRequest } from "../../lib/booking/lapse-approved-request";
import {
  CANCELLABLE_FROM,
  REQUEST_ALLOWED_FROM,
} from "../../lib/booking/transitions";
import { POST as withdrawConsultation } from "../../app/api/bookings/consultations/[consultationId]/withdraw-approval/route";
import { NextRequest } from "next/server";

// CUID-shaped, so `refuseMalformedEventId` lets the route past the id gate.
const C_ID = "clzzzzzzz000consultation1";

const db = prisma as unknown as Record<
  string,
  Record<string, jest.Mock> & jest.Mock
>;

const consultationRow = {
  id: C_ID,
  status: "APPROVED_PENDING_PAYMENT",
  consultationPlan: { consultantProfileId: "cp-1" },
  requestedBy: { user: { id: "u-buyer", name: "Buyer" } },
  appointment: {
    id: "a-1",
    organizationId: null,
    occurrences: [{ startsAt: new Date("2026-09-24T09:00:00Z") }],
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  lockCalls.length = 0;
  session.user = {
    id: "u-consultant",
    role: "CONSULTANT",
    consultantProfileId: "cp-1",
    consulteeProfileId: null,
  };
  db.appointment.findFirst.mockResolvedValue({ id: "a-1" });
});

describe("CANCELLABLE_FROM permits the withdrawal edge", () => {
  it("APPROVED_PENDING_PAYMENT is in CANCELLED's allowed-from", () => {
    // Without this the change would have to force a map widening, which is
    // exactly what doctrine rule 1 forbids doing silently.
    expect(CANCELLABLE_FROM).toContain("APPROVED_PENDING_PAYMENT");
    expect(REQUEST_ALLOWED_FROM.CANCELLED).toBe(CANCELLABLE_FROM);
  });
});

describe("lapseApprovedRequest — one body, two terminal words", () => {
  it("a lapsed window is EXPIRED", async () => {
    db.subscription.updateMany.mockResolvedValue({ count: 1 });

    const out = await lapseApprovedRequest(prisma, {
      kind: "subscription",
      id: "s-1",
      reason: "PAYMENT_LAPSED",
      actorUserId: null,
    });

    expect(out).toEqual({ moved: 1, appointmentId: "a-1" });
    expect(db.subscription.updateMany.mock.calls[0][0].data.status).toBe(
      "EXPIRED",
    );
  });

  it("a withdrawal is CANCELLED", async () => {
    db.consultation.updateMany.mockResolvedValue({ count: 1 });

    const out = await lapseApprovedRequest(prisma, {
      kind: "consultation",
      id: "c-1",
      reason: "WITHDRAWN_BY_CONSULTANT",
      actorUserId: "u-consultant",
    });

    expect(out).toEqual({ moved: 1, appointmentId: "a-1" });
    expect(db.consultation.updateMany.mock.calls[0][0].data.status).toBe(
      "CANCELLED",
    );
  });

  it("BOTH edges keep the money predicate and the narrow from-set in the WHERE", async () => {
    // A withdrawal is a live act, so it must still be unable to reach a paid
    // row or a row somebody else already moved. The guards do not move with the
    // target word.
    db.consultation.updateMany.mockResolvedValue({ count: 1 });
    await lapseApprovedRequest(prisma, {
      kind: "consultation",
      id: "c-1",
      reason: "WITHDRAWN_BY_CONSULTANT",
      actorUserId: "u-consultant",
    });
    db.subscription.updateMany.mockResolvedValue({ count: 1 });
    await lapseApprovedRequest(prisma, {
      kind: "subscription",
      id: "s-1",
      reason: "PAYMENT_LAPSED",
      actorUserId: null,
    });

    for (const call of [
      db.consultation.updateMany.mock.calls[0][0],
      db.subscription.updateMany.mock.calls[0][0],
    ]) {
      expect(call.where.status).toEqual({ in: ["APPROVED_PENDING_PAYMENT"] });
      expect(JSON.stringify(call.where)).toContain(
        '"paymentStatus":"SUCCEEDED"',
      );
    }
  });

  it("a lost CAS on the CANCELLED edge is still { moved: 0 } and writes nothing", async () => {
    // The capture that won the race flipped the request first, so the
    // withdrawal must match zero rows rather than overwrite it.
    db.consultation.updateMany.mockResolvedValue({ count: 0 });

    const out = await lapseApprovedRequest(prisma, {
      kind: "consultation",
      id: "c-1",
      reason: "WITHDRAWN_BY_CONSULTANT",
      actorUserId: "u-consultant",
    });

    expect(out).toEqual({ moved: 0, appointmentId: null });
    expect(db.payment.updateMany).not.toHaveBeenCalled();
    expect(db.appointmentOccurrence.updateManyAndReturn).not.toHaveBeenCalled();
  });
});

describe("POST …/withdraw-approval answers the status it wrote", () => {
  it('200 { status: "CANCELLED" } on a won CAS, with the notice still fired', async () => {
    db.consultation.findUnique.mockResolvedValue(consultationRow);
    db.consultation.updateMany.mockResolvedValue({ count: 1 });

    const res = await withdrawConsultation(
      new NextRequest("http://localhost/x", { method: "POST" }),
      { params: Promise.resolve({ consultationId: C_ID }) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "CANCELLED" });
    expect(lockCalls).toEqual(["a-1"]);

    const where = db.consultation.updateMany.mock.calls[0][0].where;
    // A still-payable approval only: the same from-set EXPIRED used, so a paid
    // or already-terminal row cannot be withdrawn.
    expect(where.status).toEqual({ in: ["APPROVED_PENDING_PAYMENT"] });
    expect(JSON.stringify(where)).toContain('"paymentStatus":"SUCCEEDED"');
    // The pay link is cleared and the open order tombstoned, unchanged.
    expect(db.consultation.updateMany.mock.calls[0][0].data).toMatchObject({
      status: "CANCELLED",
      pendingPaymentUrl: null,
    });
    expect(db.payment.updateMany).toHaveBeenCalledWith({
      where: { appointmentId: "a-1", paymentStatus: "PENDING" },
      data: { paymentStatus: "EXPIRED" },
    });
    // The notice names the withdrawal, so the buyer is never told a window
    // lapsed on an act a person took.
    expect(notifyConsulteeRequestExpired).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentId: "a-1",
        consulteeUserId: "u-buyer",
        reason: expect.stringContaining("withdrew the approval"),
      }),
    );
  });

  it("a capture-then-withdraw is still 409 with nothing written", async () => {
    db.consultation.findUnique.mockResolvedValue({
      ...consultationRow,
      status: "APPROVED",
    });
    db.consultation.updateMany.mockResolvedValue({ count: 0 });

    const res = await withdrawConsultation(
      new NextRequest("http://localhost/x", { method: "POST" }),
      { params: Promise.resolve({ consultationId: C_ID }) },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "REQUEST_CHANGED_ELSEWHERE",
    });
    expect(db.payment.updateMany).not.toHaveBeenCalled();
    expect(notifyConsulteeRequestExpired).not.toHaveBeenCalled();
  });
});
