/**
 * @jest-environment node
 */

/**
 * Sentry FAMILIARISE_WEB-6X (#1527) — the operator Appointments read loads the
 * page's people in ONE batched user query, not one per relation path.
 */

const mockUserFindMany = jest.fn(async () => [
  { id: "u-expert", name: "Expert", email: "e@x.test", image: null },
  { id: "u-client", name: "Client", email: "c@x.test", image: null },
]);

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findMany: jest.fn(async () => [
        {
          id: "a1",
          appointmentType: "CONSULTATION",
          createdAt: new Date("2026-09-01T00:00:00Z"),
          rescheduleRequests: [],
          occurrences: [],
          _count: { participants: 1 },
          consultation: {
            id: "c1",
            status: "SCHEDULED",
            consultationPlan: {
              title: "Plan",
              durationInHours: 1,
              consultantProfile: { userId: "u-expert" },
            },
            requestedBy: { userId: "u-client" },
          },
          subscription: null,
          webinar: null,
          class: null,
          payment: [],
        },
      ]),
      count: jest.fn(async () => 1),
    },
    user: { findMany: () => mockUserFindMany() },
  },
}));

import { getStaffAppointments } from "../../lib/data/staff-appointments";

it("resolves consultant and consultee from one batched user read", async () => {
  const { appointments } = await getStaffAppointments({
    scope: { kind: "all" },
  });
  expect(mockUserFindMany).toHaveBeenCalledTimes(1);
  expect(appointments[0].consultant?.name).toBe("Expert");
  expect(appointments[0].consultee?.name).toBe("Client");
});
