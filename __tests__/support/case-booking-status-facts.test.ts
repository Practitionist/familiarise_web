/** @jest-environment node */
/**
 * The back-office case status reads the booking through the same status
 * function as the lists, with its payment and open move.
 */
import { projectRow } from "../fixtures/prisma-projection";

const HOUR = 3_600_000;
let mockAppointment: Record<string, unknown>;
const base = (over: Record<string, unknown>) => ({
  id: "appt-1",
  appointmentType: "CONSULTATION",
  occurrences: [{ startsAt: new Date(Date.now() + 48 * HOUR) }],
  consultation: {
    status: "PENDING",
    bookingSource: "REQUEST_SUBMITTED",
    requestedBy: { user: { name: "Lee" } },
    consultationPlan: {
      title: "Call",
      consultantProfile: { user: { name: "Ana" } },
    },
  },
  subscription: null,
  trial: null,
  webinar: null,
  class: null,
  participants: [],
  payment: [],
  rescheduleRequests: [],
  ...over,
});

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

import { caseBookingStatus } from "@/lib/support/case-booking-status";
import { readCaseBooking } from "@/lib/support/case-workspace";
import { bookingStatus } from "@/lib/appointments/booking-status";

const read = () => readCaseBooking("appt-1", { id: "u-lee", name: "Lee" });

it("a booking with an open move reads Being moved", async () => {
  mockAppointment = base({
    rescheduleRequests: [
      {
        id: "rr-1",
        status: "PENDING_REVIEW",
        reason: null,
        expiresAt: new Date(Date.now() + 24 * HOUR),
        initiatorRole: "CONSULTANT",
        initiatedById: "u-ana",
        proposedTimes: [
          {
            startsAt: new Date(Date.now() + 72 * HOUR),
            endsAt: new Date(Date.now() + 73 * HOUR),
          },
        ],
      },
    ],
  });
  expect(caseBookingStatus((await read())!)?.label).toBe("Being moved");
});

it("a pay-first hold whose link lapsed reads Cancelled, as the lists do", async () => {
  mockAppointment = base({
    consultation: {
      ...(base({}).consultation as Record<string, unknown>),
      bookingSource: "DIRECT_CHECKOUT",
    },
    payment: [
      {
        paymentStatus: "EXPIRED",
        expiresAt: new Date(Date.now() - HOUR),
        amount: 50_000,
        currency: "INR",
        deletedAt: null,
        userId: "u-lee",
      },
    ],
  });
  const booking = (await read())!;
  // Without the payment facts the drawer read the stored status alone.
  expect(
    bookingStatus(
      { kind: booking.kind, status: booking.status, seatStatus: null },
      "STAFF",
    ).label,
  ).not.toBe("Cancelled");
  expect(caseBookingStatus(booking)?.label).toBe("Cancelled");
});
