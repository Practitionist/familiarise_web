/**
 * @jest-environment node
 */

/**
 * The Requests list sizes a sold plan off its plan block, so that block must
 * carry the weekly cap and session length the buyer bought, not the plan's
 * current values.
 */
const findMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    subscription: {
      findMany: (...a: unknown[]) => findMany(...a),
      count: jest.fn(async () => 2),
    },
  },
}));
jest.mock("../../lib/auth-helpers", () => ({
  ...jest.requireActual("../../lib/auth-helpers"),
  requireApiAuth: async () => ({
    session: { user: { id: "u-1", role: "ADMIN" } },
  }),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/bookings/subscriptions/route";

const plan = {
  id: "plan-1",
  title: "Coaching",
  sessionsPerWeek: 5,
  sessionDurationInHours: 2,
  durationInMonths: 2,
  totalSessions: 40,
};

it("returns the frozen cadence and length for sold plans, the plan's for older rows", async () => {
  findMany.mockResolvedValue([
    {
      id: "sub-frozen",
      sessionsTotal: 24,
      sessionsPerWeek: 3,
      sessionMinutes: 60,
      sessionsRefunded: 4,
      subscriptionPlan: plan,
    },
    {
      id: "sub-legacy",
      sessionsTotal: null,
      sessionsPerWeek: null,
      sessionMinutes: null,
      sessionsRefunded: 0,
      subscriptionPlan: plan,
    },
  ]);
  const res = await GET(
    new NextRequest("http://localhost/api/bookings/subscriptions"),
  );
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(data[0]).toMatchObject({
    sessionsRefunded: 4,
    subscriptionPlan: { sessionsPerWeek: 3, sessionDurationInHours: 1 },
  });
  expect(data[1].subscriptionPlan).toMatchObject({
    sessionsPerWeek: 5,
    sessionDurationInHours: 2,
  });
  expect(findMany.mock.calls[0][0].select).toMatchObject({
    sessionsPerWeek: true,
    sessionMinutes: true,
    sessionsRefunded: true,
  });
});
