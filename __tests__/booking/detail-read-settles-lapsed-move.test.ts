/**
 * @jest-environment node
 */

// Invariant: every booking page and its API read through readAppointmentDetail,
// which ends a move past its deadline and reads the booking again.

const settle = jest.fn(async (_appointmentId: string) => true);
jest.mock("../../lib/booking/reschedule-lapse", () => ({
  settleLapsedProposal: (id: string) => settle(id),
}));
const findUnique = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { appointment: { findUnique: (a: unknown) => findUnique(a) } },
}));

import { readAppointmentDetail } from "@/lib/data/appointment-detail";

it("ends a lapsed move and returns the booking as it now stands", async () => {
  findUnique
    .mockResolvedValueOnce({
      id: "appt-1",
      occurrences: [],
      payment: [],
      participants: [],
      statusHistory: [],
      rescheduleRequests: [{ expiresAt: new Date(Date.now() - 60_000) }],
    })
    .mockResolvedValueOnce(null);
  await readAppointmentDetail("appt-1");
  expect(settle).toHaveBeenCalledWith("appt-1");
  expect(findUnique).toHaveBeenCalledTimes(2);
});

it("reads once when no move has lapsed", async () => {
  settle.mockClear();
  findUnique.mockReset().mockResolvedValueOnce(null);
  await readAppointmentDetail("appt-1");
  expect(settle).not.toHaveBeenCalled();
});
