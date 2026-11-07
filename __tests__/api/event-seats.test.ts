/**
 * @jest-environment node
 */

/**
 * GET /api/participants/event-seats answers "which webinar and class plans do I
 * hold a seat on" for the signed-in caller only. The public plan payloads carry
 * a seat count and never who holds the seats, so this is the one place a
 * client learns its own enrolment.
 */

const mockRequireApiAuth = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: (...args: unknown[]) => mockRequireApiAuth(...args),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { appointmentParticipant: { findMany: jest.fn() } },
}));

import prisma from "@/lib/prisma";
import { GET } from "@/app/api/participants/event-seats/route";

const findMany = prisma.appointmentParticipant.findMany as jest.Mock;

beforeEach(() => {
  findMany.mockReset();
  mockRequireApiAuth.mockReset();
});

describe("GET /api/participants/event-seats", () => {
  it("returns the auth refusal and reads nothing for an anonymous caller", async () => {
    mockRequireApiAuth.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      }),
    });
    const res = await GET();
    expect(res.status).toBe(401);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("asks only for the caller's own live consultee seats", async () => {
    mockRequireApiAuth.mockResolvedValue({ session: { user: { id: "u-1" } } });
    findMany.mockResolvedValue([]);
    await GET();
    const { where } = findMany.mock.calls[0][0];
    expect(where.userId).toBe("u-1");
    expect(where.role).toBe("CONSULTEE");
    expect(where.status).toEqual({ in: ["HELD", "CONFIRMED", "ATTENDED"] });
  });

  it("returns distinct plan ids, split by kind, and is never cached", async () => {
    mockRequireApiAuth.mockResolvedValue({ session: { user: { id: "u-1" } } });
    findMany.mockResolvedValue([
      {
        appointment: {
          webinar: { webinarPlanId: "wp-1" },
          class: null,
        },
      },
      {
        appointment: {
          webinar: { webinarPlanId: "wp-1" },
          class: null,
        },
      },
      {
        appointment: {
          webinar: null,
          class: { classPlanId: "cp-9" },
        },
      },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({
      data: { webinarPlanIds: ["wp-1"], classPlanIds: ["cp-9"] },
    });
  });
});
