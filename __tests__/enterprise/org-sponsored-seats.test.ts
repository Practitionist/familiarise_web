/**
 * @jest-environment node
 */

/**
 * #1852 decision 3 — the sponsor view exposes a sponsoring org's own seats on
 * its own money and nothing about anyone else on the session.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentParticipant: { count: jest.fn(), findMany: jest.fn() },
    meetingAttendance: { findMany: jest.fn() },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

import prisma from "../../lib/prisma";
import {
  getOrgSponsoredGroupSeats,
  isOrgFundedPaymentMethod,
  seatPayerOrganizationId,
  sponsoredSeatsWhere,
} from "../../lib/data/org-sponsored-seats";

const m = prisma as unknown as {
  appointmentParticipant: { count: jest.Mock; findMany: jest.Mock };
  meetingAttendance: { findMany: jest.Mock };
};

it("lists only the sponsor's own funded seats, with member, title, date and attended, and no other attendee", async () => {
  const where = sponsoredSeatsWhere("sponsor-org");
  expect(where).toMatchObject({
    organizationId: "sponsor-org",
    role: "CONSULTEE",
    payment: { organizationId: "sponsor-org" },
    user: { memberships: { some: { organizationId: "sponsor-org" } } },
  });

  m.appointmentParticipant.count.mockResolvedValue(1);
  m.appointmentParticipant.findMany.mockResolvedValue([
    {
      id: "seat-1",
      userId: "u-1",
      appointmentId: "appt-1",
      status: "CONFIRMED",
      user: { name: "Asha", email: "asha@sponsor.test" },
      appointment: {
        webinar: { webinarPlan: { title: "Negotiation 101" } },
        class: null,
        occurrences: [{ startsAt: new Date("2026-10-01T10:00:00Z") }],
      },
    },
  ]);
  m.meetingAttendance.findMany.mockResolvedValue([
    { userId: "u-1", occurrence: { appointmentId: "appt-1" } },
  ]);

  const { items } = await getOrgSponsoredGroupSeats("sponsor-org");
  expect(m.appointmentParticipant.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where }),
  );
  // The whole row, so any field added later (another attendee, the host,
  // the payment) fails this pin.
  expect(items).toEqual([
    {
      id: "seat-1",
      member: { name: "Asha", email: "asha@sponsor.test" },
      sessionTitle: "Negotiation 101",
      startsAt: "2026-10-01T10:00:00.000Z",
      attended: true,
    },
  ]);
});

// #1854 (ADR 19) — a member's personal purchase carries no org; the org's
// own money tags the seat.
it("tags a seat with the org only when the org's money paid for it", () => {
  const seat = (method: string) =>
    seatPayerOrganizationId("org-1", isOrgFundedPaymentMethod(method));
  expect(seat("CARD")).toBeNull();
  expect(seat("UPI")).toBeNull();
  expect(seat("WALLET")).toBe("org-1");
  expect(seat("LICENSE")).toBe("org-1");
});
