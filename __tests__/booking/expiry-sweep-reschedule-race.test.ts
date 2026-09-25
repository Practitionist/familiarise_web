/**
 * @jest-environment node
 */

/**
 * E2E-audit P0 — the stale-request expiry sweep must never reap a booking
 * that has a LIVE reschedule proposal against it.
 *
 * The hole: a reschedule flips a consultation back to PENDING, and the sweep
 * expires any PENDING consultation older than 48h by `requestedAt`. Because
 * `requestedAt` kept its ORIGINAL value across the flip, every rescheduled
 * consultation older than two days was auto-EXPIRED and fully refunded by the
 * next hourly run — while its proposal was still open and the consultant was
 * still expected to answer it. The proposal system budgets its own 72h
 * lifetime; the two clocks raced and the sweep always won.
 *
 * The guard is deliberately belt-and-braces, so both halves are pinned here:
 * the cohort READ excludes live proposals, and the terminal UPDATE re-checks
 * at WRITE time (PENDING is reschedulable, so a proposal can be opened in the
 * window between the two statements).
 */

import "../booking-algorithm/setup";

const refundBookingPayment = jest.fn();
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  __esModule: true,
  refundBookingPayment: (...a: unknown[]) =>
    refundBookingPayment(...(a as [never])),
}));

jest.mock("../../lib/prisma", () => {
  const db: Record<string, unknown> = {
    consultation: {
      findMany: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    subscription: {
      findMany: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    appointmentOccurrence: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateManyAndReturn: jest.fn().mockResolvedValue([]),
    },
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    appointment: { findMany: jest.fn() },
    $disconnect: jest.fn(),
  };
  // The payment-pending arm now expires each request in its own transaction.
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { __esModule: true, default: db };
});

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));

import prisma from "../../lib/prisma";
import { expireStaleRequests } from "../../scripts/appointments/expire-stale-requests";
import { RESCHEDULE_OPEN_STATUSES } from "@/lib/booking/transitions";
import { AppointmentStatus } from "@prisma/client";

/**
 * Every guard in the sweep is expressed as "no reschedule request of mine is
 * in an open status". `RESCHEDULE_OPEN_STATUSES` is spread into the Prisma
 * filter, so compare against a copy rather than the frozen module constant.
 */
const openStatusFilter = { status: { in: [...RESCHEDULE_OPEN_STATUSES] } };

describe("expiry sweep × live reschedule proposals", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.subscription.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.appointment.findMany as jest.Mock).mockResolvedValue([]);
  });

  it("the open-status list is non-empty, or every guard below is vacuous", () => {
    // Guard-the-guard: if RESCHEDULE_OPEN_STATUSES were ever emptied, the
    // `none: { status: { in: [] } }` filters would match everything and the
    // assertions in this file would keep passing while the hole reopened.
    expect(RESCHEDULE_OPEN_STATUSES.length).toBeGreaterThan(0);
    expect(RESCHEDULE_OPEN_STATUSES).toEqual(
      expect.arrayContaining(["PENDING_REVIEW", "COUNTERED"]),
    );
  });

  describe("PENDING consultations", () => {
    it("excludes bookings with a live proposal from the cohort READ", async () => {
      await expireStaleRequests();

      const cohortRead = (prisma.consultation.findMany as jest.Mock).mock.calls
        .map(([args]) => args)
        .find((args) => args?.where?.status === AppointmentStatus.PENDING);

      expect(cohortRead).toBeDefined();
      expect(cohortRead.where.appointment).toEqual({
        rescheduleRequests: { none: openStatusFilter },
      });
      // The original staleness predicate must survive alongside the guard.
      expect(cohortRead.where.requestedAt).toHaveProperty("lt");
    });

    it("re-checks the guard at WRITE time, not just at read time", async () => {
      (prisma.consultation.findMany as jest.Mock).mockResolvedValueOnce([
        { id: "cons-1", appointment: { id: "apt-1" } },
      ]);
      (prisma.consultation.updateMany as jest.Mock).mockResolvedValue({
        count: 1,
      });

      await expireStaleRequests();

      const terminalWrite = (
        prisma.consultation.updateMany as jest.Mock
      ).mock.calls
        .map(([args]) => args)
        .find((args) => args?.data?.status === AppointmentStatus.EXPIRED);

      expect(terminalWrite).toBeDefined();
      // Without this, a proposal opened between the read and the write still
      // gets its booking expired — PENDING is a reschedulable state.
      expect(terminalWrite.where.appointment).toEqual({
        rescheduleRequests: { none: openStatusFilter },
      });
      // Through the CAS helper now: the from-set rides the WHERE as a list.
      expect(terminalWrite.where.status).toEqual({
        in: [AppointmentStatus.PENDING],
      });
    });
  });

  describe("PENDING subscriptions", () => {
    it("excludes whole-subscription reschedules from both the read and the write", async () => {
      (prisma.subscription.findMany as jest.Mock)
        .mockResolvedValueOnce([
          {
            id: "sub-1",
            requestedAt: new Date("2026-01-01"),
            requestedBy: { user: { name: "Buyer", email: "" } },
            subscriptionPlan: {
              consultantProfile: { user: { name: "Consultant", email: "" } },
            },
          },
        ])
        .mockResolvedValueOnce([]);
      (prisma.subscription.updateMany as jest.Mock).mockResolvedValue({
        count: 1,
      });

      await expireStaleRequests();

      // #1554 — a subscription owns ONE appointment, which may not exist yet
      // (unallocated), so the guard is "no wrapper, or a wrapper with no open
      // proposal".
      const expectedGuard = {
        OR: [
          { appointment: null },
          {
            appointment: {
              rescheduleRequests: { none: openStatusFilter },
            },
          },
        ],
      };

      const cohortRead = (prisma.subscription.findMany as jest.Mock).mock.calls
        .map(([args]) => args)
        .find((args) => args?.where?.status === AppointmentStatus.PENDING);
      expect(cohortRead).toBeDefined();
      expect(cohortRead.where.OR).toEqual(expectedGuard.OR);

      const terminalWrite = (
        prisma.subscription.updateMany as jest.Mock
      ).mock.calls
        .map(([args]) => args)
        .find((args) => args?.data?.status === AppointmentStatus.EXPIRED);
      expect(terminalWrite).toBeDefined();
      expect(terminalWrite.where.OR).toEqual(expectedGuard.OR);
    });
  });

  it("an APPROVED subscription with one COMPLETED occurrence is in neither cohort (#1766)", async () => {
    await expireStaleRequests();

    // The APPROVED expiry sweep excludes any wrapper holding a live
    // non-tentative row; a COMPLETED row is exactly that, so a plan whose first
    // cycle was delivered and is waiting on its next cycle is left alone.
    // #1775 C-4 — the nudge now reads the paid PENDING cohort instead.
    const approvedReads = (prisma.subscription.findMany as jest.Mock).mock.calls
      .map(([args]) => args)
      .filter((args) => args?.where?.status === AppointmentStatus.APPROVED);
    expect(approvedReads).toHaveLength(1);
    const held = { isTentative: false, deletedAt: null };
    for (const read of approvedReads) {
      expect(read.where.NOT).toEqual({
        appointment: { occurrences: { some: held } },
      });
    }
    // The predicate carries no completionStatus filter, so a COMPLETED row
    // satisfies `some` and takes the row out of the cohort.
    const completedRow = {
      isTentative: false,
      deletedAt: null,
      completionStatus: "COMPLETED",
    };
    expect(
      Object.entries(held).every(
        ([key, value]) => completedRow[key as keyof typeof held] === value,
      ),
    ).toBe(true);
  });

  it("still expires and refunds a genuinely stale booking with no proposal", async () => {
    // The guard must not have turned the sweep into a no-op: with no live
    // proposal the cohort is still collected, expired and refunded.
    (prisma.subscription.findMany as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: "sub-stale",
          requestedAt: new Date("2026-01-01"),
          requestedBy: { user: { name: "Buyer", email: "" } },
          subscriptionPlan: {
            consultantProfile: { user: { name: "Consultant", email: "" } },
          },
        },
      ])
      .mockResolvedValueOnce([]);
    (prisma.subscription.updateMany as jest.Mock).mockResolvedValue({
      count: 1,
    });
    (prisma.appointment.findMany as jest.Mock).mockResolvedValue([
      {
        id: "apt-stale",
        payment: [{ id: "pay-1", paymentStatus: "SUCCEEDED" }],
      },
    ]);
    refundBookingPayment.mockResolvedValue({ status: "SUCCEEDED" });

    const result = await expireStaleRequests();

    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-1" }),
    );
    expect(result.refundsIssued).toBe(1);
  });
});
