/**
 * @jest-environment node
 */

/**
 * The timeline's "Booked by" row names when the booking was made. A move
 * restarts the request's hold clock (`requestedAt`), so the row reads the
 * row's creation time, through the detail page's real query.
 */
import { projectRow } from "../fixtures/prisma-projection";
import {
  later,
  payment,
  plan,
  request,
  wrapper,
} from "../fixtures/stored-bookings";

type Row = Record<string, unknown>;
let mockStored: Row;
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findUnique: (args: Row) => Promise.resolve(projectRow(mockStored, args)),
    },
  },
}));

import { readAppointmentDetail } from "@/lib/data/appointment-detail";
import { toPresentationInput } from "@/lib/appointments/presentation-input";
import { deriveBookingPresentation } from "@/lib/dashboard/money-state";

const HOUR = 3_600_000;

it("shows the booking's creation time after a move restarted the hold clock", async () => {
  const bookedAt = later(-48 * HOUR);
  const movedAt = later(-HOUR);
  mockStored = wrapper({
    appointmentType: "CONSULTATION",
    consultationId: "c-1",
    consultation: {
      id: "c-1",
      ...request("APPROVED"),
      requestedAt: movedAt,
      createdAt: bookedAt,
      consultationPlanId: "plan-1",
      consultationPlan: plan,
    },
    occurrences: [
      {
        id: "occ-1",
        appointmentId: "appt-1",
        ordinal: 1,
        startsAt: later(24 * HOUR),
        endsAt: later(25 * HOUR),
        isTentative: false,
        completionStatus: "SCHEDULED",
        outcome: null,
        deletedAt: null,
        meeting: null,
      },
    ],
    payment: [
      {
        ...payment("paid"),
        taxAmount: 0,
        paymentGateway: "RAZORPAY",
        receiptUrl: null,
        capturedAt: later(-47 * HOUR),
        consumerInvoice: null,
        disputes: [],
        legs: [],
        childPayments: [],
      },
    ],
    organization: null,
    statusHistory: [],
    rescheduleRequests: [],
  });

  const detail = await readAppointmentDetail("appt-1");
  if (!detail) throw new Error("detail not read");
  const { timeline } = deriveBookingPresentation(
    toPresentationInput(detail, {
      viewerId: null,
      names: { payer: "Charlotte", consultant: "Hannah" },
      sponsorOrgName: null,
    }),
    "CONSULTANT",
    { viewerZone: "Asia/Kolkata" },
  );

  const booked = timeline.find((e) => e.label.startsWith("Booked by"));
  expect(booked?.at?.toISOString()).toBe(bookedAt.toISOString());
});
