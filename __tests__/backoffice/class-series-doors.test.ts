/**
 * @jest-environment node
 */

/**
 * #1771 K-6 — the class-series doors, one pin per group: a staff door writes
 * its audit row, staff are refused the money doors (series cancel, skip a
 * make-up) before anything runs, and a
 * make-up past day 14 cannot be granted without a reason.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => {
  const { NextResponse } = jest.requireActual("next/server");
  const { hasBackofficePermission } = jest.requireActual(
    "../../lib/auth/backoffice-permissions",
  );
  return {
    requireBackofficeSurface: async (surface: string) =>
      hasBackofficePermission("STAFF", surface)
        ? { session: { user: { id: "staff_1", role: "STAFF" } } }
        : { error: NextResponse.json({}, { status: 403 }) },
  };
});
const create = jest.fn(async (_a: unknown) => ({ id: "row" }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (t: unknown) => unknown) =>
      fn({ opsActionLog: { create: (a: unknown) => create(a) } }),
    opsActionLog: { create: (a: unknown) => create(a) },
  },
}));
const cancelAppointment = jest.fn();
jest.mock("../../app/api/appointments/[appointmentId]/cancel/route", () => ({
  POST: (...a: unknown[]) => cancelAppointment(...a),
}));
jest.mock("../../utils/appointmentlock", () => ({
  withAppointmentLock: jest.fn(),
}));
jest.mock("../../lib/novu/stage-bell", () => ({ stageBell: jest.fn() }));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  fundingRailForIntent: jest.fn(),
  refundBookingPayment: jest.fn(),
}));
jest.mock("../../lib/payments/payouts/earnings-hold", () => ({
  recomputeEarningsHold: jest.fn(),
}));

import { NextRequest } from "next/server";
import { POST as note } from "../../app/api/admin/class-series/[classId]/note/route";
import { POST as cancelSeries } from "../../app/api/admin/class-series/[classId]/cancel-series/route";
import { POST as skipMakeUp } from "../../app/api/admin/class-series/[classId]/skip-make-up/route";
import { scheduleClassMakeUp } from "../../lib/booking/class-sessions";

const call = (door: typeof note, body: unknown): ReturnType<typeof note> =>
  door(
    new NextRequest("https://x.test/api", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ classId: "cls_1" } as never) },
  );

beforeEach(() => jest.clearAllMocks());

it("a staff door writes one audit row", async () => {
  const res = await call(note, { reason: "host asked for a call back" });
  expect(res.status).toBe(200);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0][0]).toMatchObject({
    data: { surface: "classSeries.support", targetId: "cls_1" },
  });
});

it("refuses staff on the admin money doors before anything runs", async () => {
  const res = await call(cancelSeries, { reason: "host left the platform" });
  expect(res.status).toBe(403);
  const skip = await call(skipMakeUp, {
    occurrenceId: "occ_1",
    userId: "u_1",
    reason: "learner cannot make it",
  });
  expect(skip.status).toBe(403);
  expect(cancelAppointment).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it("refuses a 14-day bypass without a reason", async () => {
  await expect(
    scheduleClassMakeUp({} as never, "occ_1", new Date(), {
      bypassWindow: { opsActorUserId: "staff_1", reason: " " },
    }),
  ).rejects.toMatchObject({ code: "BYPASS_NEEDS_REASON" });
});
