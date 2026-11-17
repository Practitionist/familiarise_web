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

describe("without payments.read", () => {
  const lapsedHold = () =>
    base({
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

  it("the payment facts are withheld", async () => {
    mockAppointment = lapsedHold();
    const booking = (await readCaseBooking(
      "appt-1",
      { id: "u-lee", name: "Lee" },
      { showPayment: false },
    ))!;
    expect(booking.facts).not.toHaveProperty("paid");
    expect(booking.facts).not.toHaveProperty("payDeadline");
    expect(booking.facts).not.toHaveProperty("payLapsed");
    expect(booking.facts.source).toBe("DIRECT_CHECKOUT");
  });

  it("the status derives without them, and an open move still shows", async () => {
    mockAppointment = {
      ...lapsedHold(),
      rescheduleRequests: [
        {
          id: "rr-1",
          status: "PENDING_REVIEW",
          reason: null,
          expiresAt: new Date(Date.now() + 24 * HOUR),
          initiatorRole: "CONSULTANT",
          initiatedById: "u-ana",
          proposedTimes: [],
        },
      ],
    };
    const gated = (await readCaseBooking(
      "appt-1",
      { id: "u-lee", name: "Lee" },
      { showPayment: false },
    ))!;
    expect(caseBookingStatus(gated)?.label).toBe("Being moved");
    mockAppointment = lapsedHold();
    const plain = (await readCaseBooking(
      "appt-1",
      { id: "u-lee", name: "Lee" },
      { showPayment: false },
    ))!;
    expect(caseBookingStatus(plain)?.label).not.toBe("Cancelled");
  });
});

describe("a whole-booking move that lapsed before cleanup", () => {
  it("reads as the original, as the lists restore it", async () => {
    mockAppointment = base({
      occurrences: [
        {
          startsAt: new Date(Date.now() + 48 * HOUR),
          isTentative: true,
          completionStatus: "RESCHEDULED",
          deletedAt: null,
        },
      ],
      payment: [
        {
          paymentStatus: "SUCCEEDED",
          expiresAt: null,
          amount: 50_000,
          currency: "INR",
          deletedAt: null,
          userId: "u-lee",
          refunds: [],
        },
      ],
      rescheduleRequests: [
        {
          id: "rr-1",
          status: "PENDING_REVIEW",
          reason: null,
          expiresAt: new Date(Date.now() - HOUR),
          originStatus: "APPROVED",
          initiatorRole: "CONSULTANT",
          initiatedById: "u-ana",
          proposedTimes: [],
        },
      ],
    });
    const booking = (await read())!;
    expect(booking.status).toBe("APPROVED");
    expect(booking.facts.reschedule).toBeNull();
    expect(caseBookingStatus(booking)?.label).not.toBe("Requested");
  });
});

describe("a cancelled booking whose refund landed", () => {
  const refunded = () =>
    base({
      consultation: {
        ...(base({}).consultation as Record<string, unknown>),
        status: "CANCELLED",
      },
      payment: [
        {
          paymentStatus: "SUCCEEDED",
          expiresAt: null,
          amount: 50_000,
          currency: "INR",
          deletedAt: null,
          userId: "u-lee",
          refunds: [
            {
              status: "SUCCEEDED",
              deletedAt: null,
              amountPaise: 50_000,
              updatedAt: new Date(Date.now() - HOUR),
            },
            {
              status: "FAILED",
              deletedAt: null,
              amountPaise: 50_000,
              updatedAt: new Date(Date.now() - 2 * HOUR),
            },
          ],
        },
      ],
    });

  it("reads Refunded with payments.read, as the learner's list does", async () => {
    mockAppointment = refunded();
    const booking = (await read())!;
    expect(booking.facts.refunded).toMatchObject({
      paise: 50_000,
      currency: "INR",
    });
    expect(caseBookingStatus(booking)?.label).toBe("Refunded");
  });

  it("reads Cancelled without payments.read, with no refund facts", async () => {
    mockAppointment = refunded();
    const booking = (await readCaseBooking(
      "appt-1",
      { id: "u-lee", name: "Lee" },
      { showPayment: false },
    ))!;
    expect(booking.facts).not.toHaveProperty("refunded");
    expect(caseBookingStatus(booking)?.label).toBe("Cancelled");
  });
});
