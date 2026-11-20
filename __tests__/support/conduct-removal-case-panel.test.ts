/** @jest-environment node */
/** The staff drawer reads the requester's own seat, so a removed attendee's booking reads Cancelled, not Registered. */
import { projectRow } from "../fixtures/prisma-projection";

const mockAppointment = {
  id: "appt-1",
  appointmentType: "CLASS",
  occurrences: [{ startsAt: new Date("2026-11-20T10:00:00Z") }],
  consultation: null,
  subscription: null,
  trial: null,
  webinar: null,
  class: {
    status: "SCHEDULED",
    classPlan: {
      title: "Beginner Class",
      consultantProfile: { user: { name: "Ananya Anderson" } },
    },
  },
  participants: [
    { userId: "u-learner", role: "CONSULTEE", status: "CANCELLED" },
    { userId: "u-other", role: "CONSULTEE", status: "CONFIRMED" },
  ],
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findUnique: jest.fn(async (args: Record<string, unknown>) =>
        projectRow(mockAppointment, args),
      ),
    },
  },
}));

import { bookingStatus } from "@/lib/appointments/booking-status";
import {
  readCaseBooking,
  removalReviewDueAt,
} from "@/lib/support/case-workspace";

it("reads the removed attendee's seat, so the drawer says Cancelled", async () => {
  const booking = await readCaseBooking("appt-1", {
    id: "u-learner",
    name: "Isabella Brown",
  });
  expect(booking?.seatStatus).toBe("CANCELLED");
  const label = bookingStatus(
    {
      kind: booking!.kind,
      status: booking!.status,
      seatStatus: booking!.seatStatus,
    },
    "STAFF",
  ).label;
  expect(label).not.toBe("Registered");
  expect(label).toMatch(/Cancelled/);
});

it("shows the removal decision deadline only while the case is open and undecided", () => {
  const due = new Date("2026-11-21T16:57:00Z");
  const removalCase = {
    category: "CONDUCT_REMOVAL",
    status: "OPEN" as const,
    closedAt: null,
    statutoryDueAt: due,
    decisions: [] as { id: string }[],
  };
  expect(removalReviewDueAt(removalCase)).toBe(due.toISOString());
  expect(
    removalReviewDueAt({ ...removalCase, decisions: [{ id: "d-1" }] }),
  ).toBeNull();
  expect(
    removalReviewDueAt({
      ...removalCase,
      status: "CLOSED",
      closedAt: new Date("2026-11-20T00:00:00Z"),
    }),
  ).toBeNull();
  expect(
    removalReviewDueAt({ ...removalCase, category: "BILLING" }),
  ).toBeNull();
});
