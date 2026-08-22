/**
 * Anti-scalper cap for request-for-approval holds (booking-journey audit B1)
 * and the 48h PENDING-consultation expiry that keeps it honest.
 *
 * A PENDING request pins a tentative slot that blocks the consultant's
 * calendar; nothing used to bound how many one account could accumulate or
 * how long a hold could live (30 days, swept daily). These tests pin the cap
 * constant, the count query shape, and the expiry's slot release.
 */

import "./setup";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findMany: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
    subscription: { findMany: jest.fn(), updateMany: jest.fn() },
    slotOfAppointment: { deleteMany: jest.fn() },
    appointment: { findMany: jest.fn().mockResolvedValue([]) },
    $disconnect: jest.fn(),
  },
}));

// B1's sweep now routes refunds through booking-refund, whose module graph
// constructs a Stripe client (needs global fetch — absent in this env).
const refundBookingPayment = jest.fn();
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  __esModule: true,
  refundBookingPayment: (...a: unknown[]) =>
    refundBookingPayment(...(a as [never])),
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  // Pass-through so tests drive the unlocked core directly.
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));

import prisma from "../../lib/prisma";
import {
  MAX_ACTIVE_REQUESTS_PER_USER,
  countActiveConsultationRequests,
} from "../../lib/booking/request-caps";
import { expireStaleRequests } from "../../scripts/appointments/expire-stale-requests";

// Source-text pin (same style as approval-path-correctness.test.ts): the RFA
// route must acquire the CONSULTEE lock before the slot atoms — direct
// checkout uses consultee → atoms, and the reverse order here would be a
// classic ABBA deadlock against it (audit B8a).
const rfaRoute = require("fs").readFileSync(
  require("path").resolve(
    __dirname,
    "../../app/api/slots/request-for-approval/route.ts",
  ),
  "utf8",
);

describe("RFA route lock order", () => {
  it("takes the consultee lock before the slot atoms", () => {
    const consulteeAt = rfaRoute.indexOf("lockConsulteeBooking(session.user.id)");
    const atomsAt = rfaRoute.indexOf(
      "lockSlotBooking(consultantProfileId, startsAt, endsAt)",
    );
    expect(consulteeAt).toBeGreaterThan(-1);
    expect(atomsAt).toBeGreaterThan(consulteeAt);
  });

  it("enforces the active-request cap before creating the hold", () => {
    expect(rfaRoute).toContain("countActiveConsultationRequests");
    expect(rfaRoute).toContain("MAX_ACTIVE_REQUESTS_PER_USER");
  });
});

describe("RFA active-request cap", () => {
  it("caps at 3 active pending requests per user", () => {
    expect(MAX_ACTIVE_REQUESTS_PER_USER).toBe(3);
  });

  it("counts only PENDING consultations of this consultee", async () => {
    (prisma.consultation.count as jest.Mock).mockResolvedValue(2);
    const n = await countActiveConsultationRequests(
      prisma as never,
      "consultee-profile-1",
    );
    expect(n).toBe(2);
    expect(prisma.consultation.count).toHaveBeenCalledWith({
      where: {
        requestedById: "consultee-profile-1",
        status: "PENDING",
      },
    });
  });
});

describe("48h PENDING consultation expiry releases pinned slots", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.subscription.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.subscription.updateMany as jest.Mock).mockResolvedValue({
      count: 0,
    });
  });

  it("expires stale consultations by id and deletes their tentative slots", async () => {
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      { id: "c1", appointment: { id: "apt-1" } },
      { id: "c2", appointment: { id: "apt-2" } },
      { id: "c3", appointment: null }, // slot-less placeholder
    ]);
    // PR 2c — the sweep now refunds SUCCEEDED payments of expired rows.
    (prisma.appointment.findMany as jest.Mock).mockResolvedValue([]);
    (refundBookingPayment as jest.Mock).mockResolvedValue({ status: "SUCCEEDED" });
    (prisma.consultation.updateMany as jest.Mock).mockResolvedValue({
      count: 3,
    });
    (prisma.slotOfAppointment.deleteMany as jest.Mock).mockResolvedValue({
      count: 5,
    });

    const result = await expireStaleRequests();

    expect(result.success).toBe(true);
    expect(result.consultationsExpired).toBe(3);
    expect(result.consultationSlotsReleased).toBe(5);

    // The CAS guard rides the WHERE: only rows still PENDING flip.
    expect(prisma.consultation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["c1", "c2", "c3"] },
          status: "PENDING",
        }),
        data: { status: "EXPIRED" },
      }),
    );

    // Only TENTATIVE slots of consultations that are STILL expired at delete
    // time are released — the relational guard re-checks status at write
    // time, so a request approved between the read and the delete keeps its
    // hold (CodeRabbit triage on the approve-race).
    expect(prisma.slotOfAppointment.deleteMany).toHaveBeenCalledWith({
      where: {
        appointmentId: { in: ["apt-1", "apt-2"] },
        isTentative: true,
        appointment: {
          consultation: {
            id: { in: ["c1", "c2", "c3"] },
            status: "EXPIRED",
          },
        },
      },
    });
  });

  it("is a no-op when nothing is stale", async () => {
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([]);

    const result = await expireStaleRequests();

    expect(result.consultationsExpired).toBe(0);
    expect(result.consultationSlotsReleased).toBe(0);
    expect(prisma.slotOfAppointment.deleteMany).not.toHaveBeenCalled();
  });
});
