/**
 * @jest-environment node
 */

/**
 * #1775 PR-B — the lapse core and the consultant's Withdraw approval.
 *
 * `lapseApprovedRequest` is the per-row body of the 7-day pay-link sweep,
 * called by the sweep and by the withdraw routes. Both race orders are
 * pinned here: a capture that wins first has already moved the request, so
 * the CAS matches zero rows and nothing else is written (the route answers
 * 409); a withdraw that wins first leaves an EXPIRED Payment tombstone, so
 * a late capture takes the handler's `captured_after_release` refund arm —
 * that refund itself is pinned in `__tests__/payments/capture-amount-parity.test.ts`
 * ("claims an EXPIRED payment as SUCCEEDED by CAS and refunds through the
 * front door") and is not duplicated here.
 */

import "./setup";

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
  withAppointmentLock: async (id: string, fn: () => unknown) => {
    lockCalls.push(id);
    return fn();
  },
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
import { POST as withdrawConsultation } from "../../app/api/bookings/consultations/[consultationId]/withdraw-approval/route";
import { POST as withdrawSubscription } from "../../app/api/bookings/subscriptions/[subscriptionId]/withdraw-approval/route";
import { NextRequest } from "next/server";

// CUID-shaped, so `refuseMalformedEventId` lets the routes past the id gate.
const C_ID = "clzzzzzzz000consultation1";
const S_ID = "clzzzzzzz000subscription1";

const db = prisma as unknown as Record<
  string,
  Record<string, jest.Mock> & jest.Mock
>;
const post = <P extends Record<string, string>>(
  handler: (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>,
  params: P,
) =>
  handler(new NextRequest("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve(params),
  });

const consultationRow = (status: string) => ({
  id: C_ID,
  status,
  consultationPlan: { consultantProfileId: "cp-1" },
  requestedBy: { user: { id: "u-buyer", name: "Buyer" } },
  appointment: {
    id: "a-1",
    organizationId: null,
    occurrences: [{ startsAt: new Date("2026-09-24T09:00:00Z") }],
  },
});

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

describe("lapseApprovedRequest (B-1)", () => {
  it("a lost CAS is { moved: 0 } with no Payment or occurrence write", async () => {
    db.consultation.updateMany.mockResolvedValue({ count: 0 });
    const out = await lapseApprovedRequest(prisma, {
      kind: "consultation",
      id: "c-1",
      reason: "PAYMENT_LAPSED",
      actorUserId: null,
    });
    expect(out).toEqual({ moved: 0, appointmentId: null });
    expect(db.payment.updateMany).not.toHaveBeenCalled();
    expect(db.appointmentOccurrence.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("a won CAS carries the money predicate in the WHERE, then tombstones the open order and releases the holds", async () => {
    db.subscription.updateMany.mockResolvedValue({ count: 1 });
    const out = await lapseApprovedRequest(prisma, {
      kind: "subscription",
      id: "s-1",
      reason: "WITHDRAWN_BY_CONSULTANT",
      actorUserId: "u-consultant",
    });
    expect(out).toEqual({ moved: 1, appointmentId: "a-1" });
    const where = db.subscription.updateMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ["APPROVED_PENDING_PAYMENT"] });
    expect(JSON.stringify(where)).toContain('"paymentStatus":"SUCCEEDED"');
    expect(db.payment.updateMany).toHaveBeenCalledWith({
      where: { appointmentId: "a-1", paymentStatus: "PENDING" },
      data: { paymentStatus: "EXPIRED" },
    });
    expect(
      db.appointmentOccurrence.updateManyAndReturn.mock.calls[0][0].where,
    ).toMatchObject({ appointmentId: "a-1", isTentative: true });
  });
});

describe("POST …/withdraw-approval (B-2)", () => {
  it("capture-then-withdraw: the request already moved → 409, Payment untouched", async () => {
    db.consultation.findUnique.mockResolvedValue(consultationRow("APPROVED"));
    db.consultation.updateMany.mockResolvedValue({ count: 0 });
    const res = await post(withdrawConsultation, { consultationId: C_ID });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "REQUEST_CHANGED_ELSEWHERE",
    });
    expect(db.payment.updateMany).not.toHaveBeenCalled();
    expect(notifyConsulteeRequestExpired).not.toHaveBeenCalled();
  });

  it("withdraw-then-capture: the request and its open order are EXPIRED under the appointment lock, the consultee is told", async () => {
    db.subscription.findUnique.mockResolvedValue({
      ...consultationRow("APPROVED_PENDING_PAYMENT"),
      id: S_ID,
      subscriptionPlan: { consultantProfileId: "cp-1" },
    });
    db.subscription.updateMany.mockResolvedValue({ count: 1 });
    const res = await post(withdrawSubscription, { subscriptionId: S_ID });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "EXPIRED" });
    expect(lockCalls).toEqual(["a-1"]);
    // The tombstone a late capture lands on: the handler's EXPIRED→SUCCEEDED
    // claim + front-door refund (capture-amount-parity.test.ts).
    expect(db.subscription.updateMany.mock.calls[0][0].data.status).toBe(
      "EXPIRED",
    );
    expect(db.payment.updateMany).toHaveBeenCalledWith({
      where: { appointmentId: "a-1", paymentStatus: "PENDING" },
      data: { paymentStatus: "EXPIRED" },
    });
    expect(notifyConsulteeRequestExpired).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentId: "a-1",
        consulteeUserId: "u-buyer",
        appointmentType: "SUBSCRIPTION",
      }),
    );
  });

  it("the consultee cannot withdraw the consultant's approval → 403, no writes", async () => {
    session.user = {
      id: "u-buyer",
      role: "CONSULTEE",
      consultantProfileId: null,
      consulteeProfileId: "cee-1",
    };
    db.consultation.findUnique.mockResolvedValue(
      consultationRow("APPROVED_PENDING_PAYMENT"),
    );
    const res = await post(withdrawConsultation, { consultationId: C_ID });
    expect(res.status).toBe(403);
    expect(db.consultation.updateMany).not.toHaveBeenCalled();
    expect(lockCalls).toEqual([]);
  });
});
