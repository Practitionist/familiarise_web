/**
 * @jest-environment node
 */

/**
 * The unscheduled side list (runs with no sessions yet) and a date range
 * cannot be combined: the route refuses the pair instead of answering with
 * scheduled runs, and the dated scheduled list keeps working.
 */

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: jest.fn(async () => ({
    session: {
      user: { id: "u-1", role: "CONSULTANT", consultantProfileId: "cp-1" },
    },
  })),
  isPrivileged: jest.fn(() => false),
  forbiddenResponse: jest.fn(
    (message: string) =>
      new Response(JSON.stringify({ error: message }), { status: 403 }),
  ),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    membership: { findMany: jest.fn(async () => []) },
    webinar: { findMany: jest.fn(async () => []) },
  },
}));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { GET } from "@/app/api/bookings/webinars/route";

const findMany = prisma.webinar.findMany as jest.Mock;
const RANGE =
  "startDate=2026-11-01T00:00:00.000Z&endDate=2026-11-30T23:59:59.000Z";
const call = (query: string) =>
  GET(new NextRequest(`http://localhost/api/bookings/webinars?${query}`));

beforeEach(() => findMany.mockClear());

describe("GET /api/bookings/webinars — unscheduled and a date range", () => {
  it("answers 400 for unscheduled=1 with a date range and reads nothing", async () => {
    const res = await call(`consultantProfileId=cp-1&unscheduled=1&${RANGE}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "Unscheduled webinars have no dates, so they can't be filtered by a date range. Clear the dates and try again.",
      code: "INVALID_QUERY",
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("answers 400 when only one end of the range rides along", async () => {
    const res = await call(
      "consultantProfileId=cp-1&unscheduled=1&startDate=2026-11-01T00:00:00.000Z",
    );
    expect(res.status).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("keeps the unscheduled list to runs without an appointment", async () => {
    const res = await call("consultantProfileId=cp-1&unscheduled=1");
    expect(res.status).toBe(200);
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      appointment: null,
    });
  });

  it("keeps the dated scheduled list filtering by session start", async () => {
    const res = await call(`consultantProfileId=cp-1&${RANGE}`);
    expect(res.status).toBe(200);
    expect(findMany.mock.calls[0][0].where.appointment).toEqual({
      occurrences: {
        some: {
          startsAt: {
            gte: new Date("2026-11-01T00:00:00.000Z"),
            lte: new Date("2026-11-30T23:59:59.000Z"),
          },
        },
      },
    });
  });
});
