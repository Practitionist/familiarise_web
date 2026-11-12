/**
 * An unpaid approval must leave the client time to pay before the session:
 *  - the detail PATCH refuses it (409 TOO_CLOSE_TO_START) before any status
 *    write when the first session is under the unpaid lead time away;
 *  - a pay-link mint that can no longer open a window lapses the approval
 *    (EXPIRED, holds released) instead of leaving it awaiting payment.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { seedConsultee, seedHost, seedOneToOne } from "./harness";

jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(async () => ({
    id: `order_${randomUUID()}`,
    client_secret: `order_${randomUUID()}`,
  })),
  cancelPaymentIntent: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    {
      // Not a thenable: the mint loads these modules with a dynamic import.
      get: (_target, prop) =>
        prop === "then" ? undefined : prop === "__esModule" ? true : noop,
    },
  );
});
jest.mock("../../../lib/email", () => {
  const noop = jest.fn(async () => ({ success: true }));
  return new Proxy(
    {},
    {
      // Not a thenable: the mint loads these modules with a dynamic import.
      get: (_target, prop) =>
        prop === "then" ? undefined : prop === "__esModule" ? true : noop,
    },
  );
});
const sessionUser = { current: null as null | Record<string, unknown> };
jest.mock("../../../lib/auth-helpers", () => ({
  ...jest.requireActual("../../../lib/auth-helpers"),
  requireApiAuth: async () => ({ session: { user: sessionUser.current } }),
  isPrivileged: () => false,
}));
const mockRefundPayment = jest.fn(async (_input: unknown) => ({
  status: "SUCCEEDED",
}));
// Lazy: the real module is read on first use, after the import cycle settles.
jest.mock("../../../lib/payments/operations/refund", () => {
  const actual = () =>
    jest.requireActual("../../../lib/payments/operations/refund");
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "__esModule") return true;
        if (prop === "then") return undefined;
        if (prop === "refundPayment")
          return (input: unknown) => mockRefundPayment(input);
        return actual()[prop];
      },
    },
  );
});
jest.mock("../../../lib/stream/access-revocation", () => ({
  revokeEndedSeatAccess: jest.fn(async () => undefined),
  persistSeatRevocation: jest.fn(async () => undefined),
  persistSeatRevocationInTx: jest.fn(async () => null),
}));
jest.mock("../../../lib/rate-limit", () => ({
  ...jest.requireActual("../../../lib/rate-limit"),
  applyRateLimit: async () => null,
}));

import { PATCH as patchConsultation } from "../../../app/api/bookings/consultations/[consultationId]/route";
import { mintApprovalPaymentAfterCommit } from "../../../lib/booking/approve-request";
import { handlePaymentSuccess } from "../../../lib/payments/webhooks/handlers";
import { cleanupExpiredApprovalPendingPayments } from "../../../scripts/payments/cleanup-abandoned-payments";

const MIN = 60_000;
const inMinutes = (m: number) => {
  const d = new Date(Date.now() + m * MIN);
  d.setUTCMinutes(d.getUTCMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
};

describe("unpaid approval pay window", () => {
  it("the detail PATCH refuses an unpaid approval for a session under 2 h away, before writing", async () => {
    const host = await seedHost();
    const consultee = await seedConsultee();
    const startsAt = inMinutes(60);
    const request = await seedOneToOne(
      "consultation",
      host,
      consultee,
      { startsAt, endsAt: new Date(startsAt.getTime() + 60 * MIN) },
      {
        status: "PENDING",
        bookingSource: "REQUEST_SUBMITTED",
        isTentative: true,
      },
    );
    sessionUser.current = {
      id: host.userId,
      consultantProfileId: host.consultantProfileId,
    };

    const response = await patchConsultation(
      new NextRequest(
        `https://x.test/api/bookings/consultations/${request.consultationId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "APPROVED" }),
        },
      ),
      { params: Promise.resolve({ consultationId: request.consultationId! }) },
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(JSON.stringify(body)).toContain("TOO_CLOSE_TO_START");
    const row = await prisma.consultation.findUniqueOrThrow({
      where: { id: request.consultationId! },
      select: { status: true },
    });
    expect(row.status).toBe("PENDING");
  }, 30_000);

  it("a mint that can no longer open a pay window lapses the approval and releases its hold", async () => {
    const host = await seedHost();
    const consultee = await seedConsultee();
    // The next half hour at least 15 min away: 15–45 min out, so the pay
    // window (closing 15 min before) is always under the 30-min minimum.
    const startsAt = new Date(Math.ceil(Date.now() / (30 * MIN)) * 30 * MIN);
    if (startsAt.getTime() - Date.now() < 15 * MIN) {
      startsAt.setTime(startsAt.getTime() + 30 * MIN);
    }
    const request = await seedOneToOne(
      "consultation",
      host,
      consultee,
      { startsAt, endsAt: new Date(startsAt.getTime() + 60 * MIN) },
      {
        status: "APPROVED_PENDING_PAYMENT",
        bookingSource: "REQUEST_SUBMITTED",
        isTentative: true,
      },
    );

    const outcome = await mintApprovalPaymentAfterCommit({
      kind: "consultation",
      id: request.consultationId!,
    });

    expect(outcome.status).toBe("lapsed");
    const row = await prisma.consultation.findUniqueOrThrow({
      where: { id: request.consultationId! },
      select: { status: true },
    });
    expect(row.status).toBe("EXPIRED");
    const hold = await prisma.appointmentOccurrence.findUniqueOrThrow({
      where: { id: request.occurrenceId },
      select: { completionStatus: true, deletedAt: true },
    });
    expect(hold.completionStatus).toBe("CANCELLED");
    expect(hold.deletedAt).not.toBeNull();
    expect(
      await prisma.payment.count({
        where: {
          appointmentId: request.appointmentId,
          paymentStatus: "PENDING",
        },
      }),
    ).toBe(0);
  }, 30_000);

  it("a window clamped by the first session is the deadline the client is told, not 24 h", async () => {
    const host = await seedHost();
    const consultee = await seedConsultee();
    const startsAt = inMinutes(180);
    const request = await seedOneToOne(
      "consultation",
      host,
      consultee,
      { startsAt, endsAt: new Date(startsAt.getTime() + 60 * MIN) },
      {
        status: "APPROVED_PENDING_PAYMENT",
        bookingSource: "REQUEST_SUBMITTED",
        isTentative: true,
      },
    );
    const email = jest.requireMock("../../../lib/email") as {
      sendPaymentLinkEmail: jest.Mock;
    };
    const novu = jest.requireMock("../../../lib/novu") as {
      notifyPaymentLink: jest.Mock;
    };
    email.sendPaymentLinkEmail.mockClear();
    novu.notifyPaymentLink.mockClear();

    const outcome = await mintApprovalPaymentAfterCommit({
      kind: "consultation",
      id: request.consultationId!,
    });

    const closesAt = new Date(startsAt.getTime() - 15 * MIN);
    expect(outcome).toMatchObject({ status: "minted", payExpiresAt: closesAt });
    const row = await prisma.payment.findFirstOrThrow({
      where: { appointmentId: request.appointmentId, paymentStatus: "PENDING" },
      select: { expiresAt: true },
    });
    expect(row.expiresAt).toEqual(closesAt);
    // Each proxy answers every export with one mock, so keep the calls that
    // carried a deadline: the bell and the email.
    const told = [
      ...email.sendPaymentLinkEmail.mock.calls,
      ...novu.notifyPaymentLink.mock.calls,
    ]
      .map((args: unknown[]) =>
        args
          .map((arg) => (arg as { expiresAt?: unknown } | null)?.expiresAt)
          .find((value) => value instanceof Date),
      )
      .filter((value) => value !== undefined);
    expect(told).toEqual([closesAt, closesAt]);
  }, 30_000);

  it("a capture after the first session started closes the request, releases its hold and refunds in full", async () => {
    const host = await seedHost();
    const consultee = await seedConsultee();
    // The session started 30 minutes ago.
    const startsAt = new Date(Date.now() - 30 * MIN);
    startsAt.setUTCMinutes(startsAt.getUTCMinutes() < 30 ? 0 : 30, 0, 0);
    const request = await seedOneToOne(
      "consultation",
      host,
      consultee,
      { startsAt, endsAt: new Date(startsAt.getTime() + 60 * MIN) },
      {
        status: "APPROVED_PENDING_PAYMENT",
        bookingSource: "REQUEST_SUBMITTED",
        isTentative: true,
        payment: {
          status: "PENDING",
          expiresAt: new Date(Date.now() + 60 * MIN),
        },
      },
    );
    mockRefundPayment.mockClear();

    await handlePaymentSuccess(
      request.payment!.paymentIntent,
      request.captureMetadata,
      Number(request.payment!.amount),
    );

    const row = await prisma.consultation.findUniqueOrThrow({
      where: { id: request.consultationId! },
      select: { status: true },
    });
    expect(row.status).toBe("EXPIRED");
    const hold = await prisma.appointmentOccurrence.findUniqueOrThrow({
      where: { id: request.occurrenceId },
      select: { isTentative: true, completionStatus: true, deletedAt: true },
    });
    expect(hold.completionStatus).toBe("CANCELLED");
    expect(hold.deletedAt).not.toBeNull();
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: request.payment!.id },
      select: { paymentStatus: true, description: true },
    });
    expect(payment.paymentStatus).toBe("SUCCEEDED");
    expect(payment.description).toContain("after the session started");
    expect(mockRefundPayment).toHaveBeenCalledTimes(1);
    expect(mockRefundPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: request.payment!.id,
        reason: "capture after the session started",
      }),
    );
  }, 30_000);

  it("the consultee's notice for a capture after the session started commits with the capture, even when the refund throws", async () => {
    const host = await seedHost();
    const consultee = await seedConsultee();
    const startsAt = new Date(Date.now() - 30 * MIN);
    startsAt.setUTCMinutes(startsAt.getUTCMinutes() < 30 ? 0 : 30, 0, 0);
    const request = await seedOneToOne(
      "consultation",
      host,
      consultee,
      { startsAt, endsAt: new Date(startsAt.getTime() + 60 * MIN) },
      {
        status: "APPROVED_PENDING_PAYMENT",
        bookingSource: "REQUEST_SUBMITTED",
        isTentative: true,
        payment: {
          status: "PENDING",
          expiresAt: new Date(Date.now() + 60 * MIN),
        },
      },
    );
    mockRefundPayment.mockClear();
    mockRefundPayment.mockRejectedValueOnce(new Error("gateway down"));

    await handlePaymentSuccess(
      request.payment!.paymentIntent,
      request.captureMetadata,
      Number(request.payment!.amount),
    );

    expect(mockRefundPayment).toHaveBeenCalledTimes(1);
    const bells = await prisma.notificationOutbox.findMany({
      where: {
        workflowId: "appointment-cancelled",
        recipients: { has: consultee.userId },
      },
      select: { payload: true },
    });
    expect(bells).toHaveLength(1);
    expect(JSON.stringify(bells[0].payload)).toContain(
      "already started when your payment arrived",
    );
    // The email is staged next to the bell; jest's VM cannot render React
    // email (no dynamic import), so only the bell row is observable here.
  }, 30_000);

  it.each([
    ["the first session is still ahead", 20],
    ["the first session has started", -30],
  ])(
    "an approval whose pay window closed unpaid lapses on the regular pay-link sweep when %s",
    async (_label, startsInMinutes) => {
      const host = await seedHost();
      const consultee = await seedConsultee();
      const startsAt = new Date(Date.now() + startsInMinutes * MIN);
      startsAt.setUTCSeconds(0, 0);
      const request = await seedOneToOne(
        "consultation",
        host,
        consultee,
        { startsAt, endsAt: new Date(startsAt.getTime() + 60 * MIN) },
        {
          status: "APPROVED_PENDING_PAYMENT",
          bookingSource: "REQUEST_SUBMITTED",
          isTentative: true,
          // The window closed 15 min before the first session, or earlier.
          payment: {
            status: "PENDING",
            expiresAt: new Date(
              Math.min(startsAt.getTime() - 15 * MIN, Date.now() - MIN),
            ),
          },
        },
      );

      const result = await cleanupExpiredApprovalPendingPayments();

      expect(result.errors).toEqual([]);
      const row = await prisma.consultation.findUniqueOrThrow({
        where: { id: request.consultationId! },
        select: { status: true },
      });
      expect(row.status).toBe("EXPIRED");
      const hold = await prisma.appointmentOccurrence.findUniqueOrThrow({
        where: { id: request.occurrenceId },
        select: { completionStatus: true, deletedAt: true },
      });
      expect(hold.completionStatus).toBe("CANCELLED");
      expect(hold.deletedAt).not.toBeNull();
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: request.payment!.id },
        select: { paymentStatus: true },
      });
      expect(payment.paymentStatus).toBe("EXPIRED");
    },
    30_000,
  );
});
