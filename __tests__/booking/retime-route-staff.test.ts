/**
 * @jest-environment node
 */

/**
 * Only the webinar's host moves it; an operator is pointed at the back-office
 * cancel instead of a bare refusal. One seat's payment dispute does not stop
 * the host's move.
 */
import { NextRequest } from "next/server";

const mockActor = jest.fn();
const mockRetime = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({ session: { user: { id: "u-staff" } } }),
  resolveEventHostActor: (...args: unknown[]) => mockActor(...args),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  eventMutationLimiter: {},
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findUnique: async () => ({ webinarId: "web-1" }) },
  },
}));
// One seat's payment is under a live dispute.
jest.mock("../../lib/payments/dispute-guard", () => ({
  hasActiveDisputeForAppointment: async () => true,
}));
jest.mock("../../lib/booking/event-retime", () => ({
  retimeWebinar: (...args: unknown[]) => mockRetime(...args),
}));

import { POST } from "../../app/api/appointments/[appointmentId]/retime/route";

const call = () =>
  POST(
    new NextRequest("http://localhost/api/appointments/apt-1/retime", {
      method: "POST",
      body: JSON.stringify({ startsAt: "2026-12-01T10:00:00.000Z" }),
    }),
    { params: Promise.resolve({ appointmentId: "apt-1" }) },
  );

it("points an operator to Cancel instead of moving the webinar", async () => {
  mockActor.mockResolvedValue("staff");
  const res = await call();
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.code).toBe("RETIME_HOST_ONLY");
  expect(body.error).toContain("cancel it instead");
  expect(mockRetime).not.toHaveBeenCalled();
});

it("hides the webinar from a stranger", async () => {
  mockActor.mockResolvedValue(null);
  const res = await call();
  expect(res.status).toBe(404);
});

it("lets the host move the webinar while one seat's payment is disputed", async () => {
  mockActor.mockResolvedValue("consultant");
  mockRetime.mockResolvedValue({ moved: true });
  const res = await call();
  expect(res.status).toBe(200);
  expect(mockRetime).toHaveBeenCalledWith(
    expect.objectContaining({ appointmentId: "apt-1" }),
  );
});
