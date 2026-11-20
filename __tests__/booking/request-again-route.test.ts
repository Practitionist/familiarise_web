/**
 * @jest-environment node
 */

// The request-again route parses the booking id before acting and answers in the shape the control parses.

const mockClose = jest.fn();
jest.mock("../../lib/booking/request-again", () => ({
  closeOrderForRequestAgain: (...args: unknown[]) => mockClose(...args),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({ session: { user: { id: "user-1" } } }),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  eventMutationLimiter: {},
}));

import { NextRequest } from "next/server";

import { POST } from "../../app/api/bookings/[bookingId]/request-again/route";
import {
  REQUEST_AGAIN_ALREADY_PAID,
  RequestAgainAnswerSchema,
} from "../../lib/booking/request-again-rules";

const BOOKING = "7f1c2a9e-4b6d-4c1a-9e2f-0a1b2c3d4e5f";
const call = (bookingId: string) =>
  POST(new NextRequest("http://test/api"), {
    params: Promise.resolve({ bookingId }),
  });

beforeEach(() => mockClose.mockReset());

describe("POST /api/bookings/[bookingId]/request-again", () => {
  it("refuses an id the schema rejects before touching the booking", async () => {
    const res = await call("not-a-uuid");
    expect(res.status).toBe(400);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it("answers each outcome in the shape the control parses", async () => {
    mockClose.mockResolvedValueOnce({ ok: true, closed: 1 });
    const ok = await call(BOOKING);
    expect(ok.status).toBe(200);
    expect(RequestAgainAnswerSchema.parse(await ok.json())).toEqual({
      closed: 1,
    });
    expect(mockClose).toHaveBeenCalledWith({
      appointmentId: BOOKING,
      userId: "user-1",
    });

    mockClose.mockResolvedValueOnce({ ok: false, code: "ALREADY_PAID" });
    const paid = await call(BOOKING);
    expect(paid.status).toBe(409);
    expect(RequestAgainAnswerSchema.parse(await paid.json())).toEqual({
      code: "ALREADY_PAID",
      error: REQUEST_AGAIN_ALREADY_PAID,
    });
  });
});
