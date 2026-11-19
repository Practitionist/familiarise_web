/**
 * @jest-environment node
 */

/**
 * The staff panel lists every seat a lift could open: a marked removal, a free
 * seat with no recorded leave, and an unmarked seat whose learner's conduct
 * removal still stands, paid or free, shown as a conduct removal.
 */

const mockConduct = { standing: true, type: "WEBINAR" };
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findUnique: jest.fn(async () => ({
        id: "appt-1",
        appointmentType: mockConduct.type,
        classId: null,
        subscriptionId: null,
        occurrences: [],
        payment: [],
        participants: [
          {
            id: "part-paid",
            user: { id: "u-paid", name: "Dev" },
            removedByUserId: null,
            payment: {
              paymentIntent: "order_1",
              amount: 50_000,
              originalAmount: 50_000,
            },
          },
          {
            id: "part-left",
            user: { id: "u-left", name: "Riya" },
            removedByUserId: null,
            payment: {
              paymentIntent: "order_2",
              amount: 50_000,
              originalAmount: 50_000,
            },
          },
        ],
      })),
    },
    bookingStatusHistory: {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
    },
    supportCase: {
      findMany: jest.fn(async () => [{ requesterUserId: "u-paid" }]),
      findFirst: jest.fn(async () =>
        mockConduct.standing
          ? { id: "case-1", createdAt: new Date("2026-11-01T00:00:00Z") }
          : null,
      ),
    },
    supportCaseDecision: { findFirst: jest.fn(async () => null) },
    appointmentParticipant: {
      findUnique: jest.fn(async () => ({ id: "part-paid" })),
    },
  },
}));

import { readBookingOps } from "@/lib/backoffice/booking-ops-read";

it("lists an unmarked paid seat whose conduct removal still stands, as a conduct removal", async () => {
  const view = await readBookingOps("appt-1");
  expect(view?.removedSeats).toEqual([
    { userId: "u-paid", name: "Dev", removal: "CONDUCT", paidSeat: true },
  ]);
});

it("leaves an unmarked paid seat out once its conduct removal no longer stands", async () => {
  mockConduct.standing = false;
  const view = await readBookingOps("appt-1");
  expect(view?.removedSeats).toEqual([]);
});

it("lists no learner row of a 1:1 booking, whatever its case or history", async () => {
  Object.assign(mockConduct, { standing: true, type: "CONSULTATION" });
  const view = await readBookingOps("appt-1");
  expect(view?.removedSeats).toEqual([]);
});
