/**
 * PR 2c money fix — the expiry sweep must refund SUCCEEDED payments of
 * expired engagements through the booking front door, and drain the immortal
 * APPROVED-unallocated subscription cohort (audit gaps #1 + #3).
 */

import "./setup";

const refundBookingPayment = jest.fn();
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  __esModule: true,
  refundBookingPayment: (...a: unknown[]) => refundBookingPayment(...(a as [never])),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    subscription: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    slotOfAppointment: { deleteMany: jest.fn() },
    appointment: { findMany: jest.fn() },
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));

import prisma from "../../lib/prisma";
import { expireStaleRequests } from "../../scripts/appointments/expire-stale-requests";
import { AppointmentStatus } from "@prisma/client";

describe("expiry sweep refunds (PR 2c)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.subscription.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.appointment.findMany as jest.Mock).mockResolvedValue([]);
  });

  it("refunds SUCCEEDED payments of expired PENDING subscriptions via the front door", async () => {
    const richRow = {
      id: "sub-1",
      requestedAt: new Date("2026-01-01"),
      requestedBy: { user: { name: "Buyer", email: "" } },
      subscriptionPlan: {
        consultantProfile: { user: { name: "Consultant", email: "" } },
      },
    };
    ((prisma.subscription.findMany as unknown) as jest.Mock)
              .mockResolvedValueOnce([richRow]) // PENDING cohort
      .mockResolvedValueOnce([]); // APPROVED-unallocated cohort: empty
    (prisma.subscription.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    ((prisma.appointment.findMany as unknown) as jest.Mock).mockResolvedValue([
      {
        id: "apt-1",
        payment: [
          { id: "pay-succeeded", paymentStatus: "SUCCEEDED" },
          { id: "pay-failed", paymentStatus: "FAILED" },
        ],
      },
    ]);
    refundBookingPayment.mockResolvedValue({ status: "SUCCEEDED" });

    const result = await expireStaleRequests();

    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay-succeeded",
        initiatedByUserId: null,
        reason: expect.stringContaining("expired"),
      }),
    );
    expect(result.refundsIssued).toBe(1);
    expect(result.refundFailures).toBe(0);
  });

  it("counts a front-door refusal as a failure without stalling the sweep", async () => {
    ((prisma.subscription.findMany as unknown) as jest.Mock)
            .mockResolvedValueOnce([
        {
          id: "sub-1",
          requestedAt: new Date("2026-01-01"),
          requestedBy: { user: { name: "B", email: "" } },
          subscriptionPlan: {
            consultantProfile: { user: { name: "C", email: "" } },
          },
        },
      ])
      .mockResolvedValueOnce([]);
    (prisma.subscription.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    ((prisma.appointment.findMany as unknown) as jest.Mock).mockResolvedValue([
      { id: "apt-1", payment: [{ id: "pay1", paymentStatus: "SUCCEEDED" }] },
    ]);
    refundBookingPayment.mockRejectedValue(
      new Error("REFUND_FRONT_DOOR_REFUSAL"),
    );

    const result = await expireStaleRequests();

    expect(result.refundsIssued).toBe(0);
    expect(result.refundFailures).toBe(1);
    expect(result.errors.join("; ")).toContain("Refund failed");
  });

  it("drains the immortal APPROVED-unallocated cohort (zero live confirmed slots)", async () => {
    // First findMany call = PENDING subs (none); second = APPROVED cohort.
    ((prisma.subscription.findMany as unknown) as jest.Mock)
            .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "sub-immortal" }]);
    (prisma.subscription.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    ((prisma.appointment.findMany as unknown) as jest.Mock).mockResolvedValue([
      { id: "placeholder", payment: [{ id: "pay-paid", paymentStatus: "SUCCEEDED" }] },
    ]);
    refundBookingPayment.mockResolvedValue({ status: "SUCCEEDED" });

    const result = await expireStaleRequests();

    // Cohort filter: APPROVED + stale + zero confirmed slots.
    const cohortCall = (prisma.subscription.findMany as jest.Mock).mock.calls[1][0];
    expect(cohortCall.where.status).toBe(AppointmentStatus.APPROVED);
    expect(JSON.stringify(cohortCall.where.NOT)).toContain("isTentative");
    // The transition guard rides the WHERE.
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: AppointmentStatus.APPROVED,
        }),
        data: { status: "EXPIRED" },
      }),
    );
    expect(result.subscriptionsExpired).toBe(1);
    expect(result.refundsIssued).toBe(1);
  });
});
