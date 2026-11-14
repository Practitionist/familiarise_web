/**
 * @jest-environment node
 */

// Invariant: a short-notice proposal nobody accepted is over at the session's
// start; the join gate ends it and restores the original there and then,
// without waiting for the expiry job.

const findFirst = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    rescheduleRequest: { findFirst: (...a: unknown[]) => findFirst(...a) },
    $transaction: (run: (tx: unknown) => unknown) => run({}),
  },
}));
jest.mock("../../utils/appointmentlock", () => ({
  withAppointmentLock: (_id: string, run: () => unknown) => run(),
  AppointmentBusyError: class extends Error {},
  BookingLockUnavailableError: class extends Error {},
}));
const transitionRescheduleRequest = jest.fn();
jest.mock("../../lib/booking/transitions", () => ({
  transitionRescheduleRequest: (...a: unknown[]) =>
    transitionRescheduleRequest(...a),
}));
const restoreRescheduledBooking = jest.fn();
jest.mock("../../lib/booking/reschedule-restore", () => ({
  isRestoreMiss: () => false,
  restoreRescheduledBooking: (...a: unknown[]) =>
    restoreRescheduledBooking(...a),
}));
jest.mock("../../lib/booking/reschedule-outcome-notice", () => ({
  notifyRescheduleRestored: jest.fn(),
}));
jest.mock("../../lib/email", () => ({ EMAIL_BUDGET_MS: { REQUEST: 1 } }));

import { settleLapsedProposal } from "@/lib/booking/reschedule-lapse";

const START = new Date("2030-05-01T10:30:00.000Z");

it("at its deadline (the join window's opening), an unanswered proposal ends and the original is restored", async () => {
  findFirst.mockResolvedValue({
    id: "req-1",
    appointmentId: "appt-1",
    createdAt: new Date("2030-05-01T09:00:00.000Z"),
    originStatus: "APPROVED",
    releasedOccurrenceIds: ["occ-1"],
    appointment: { consultationId: "con-1", subscriptionId: null },
  });
  restoreRescheduledBooking.mockResolvedValue(1);

  expect(await settleLapsedProposal("appt-1", START)).toBe(true);
  expect(findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { openForAppointmentId: "appt-1", expiresAt: { lte: START } },
    }),
  );
  expect(transitionRescheduleRequest).toHaveBeenCalledWith(
    {},
    expect.objectContaining({
      to: "EXPIRED",
      whereAnd: { expiresAt: { lte: START } },
    }),
  );
  expect(restoreRescheduledBooking).toHaveBeenCalled();
});

it("before the deadline nothing is touched", async () => {
  findFirst.mockResolvedValue(null);
  transitionRescheduleRequest.mockClear();
  expect(await settleLapsedProposal("appt-1", START)).toBe(false);
  expect(transitionRescheduleRequest).not.toHaveBeenCalled();
});
