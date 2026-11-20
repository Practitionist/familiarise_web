/**
 * The booking page's money line names what a late capture really does: an
 * order still PENDING past its window confirms the booking while the time is
 * free, and an order the expiry sweep claimed is refunded.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";

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
      // Not a thenable: the capture loads these modules with a dynamic import.
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
      get: (_target, prop) =>
        prop === "then" ? undefined : prop === "__esModule" ? true : noop,
    },
  );
});
jest.mock("../../../lib/stream/access-revocation", () =>
  jest.requireActual("./harness-edges").chatRevocationMock(),
);
jest.mock("../../../lib/rate-limit", () =>
  jest.requireActual("./harness-edges").rateLimitMock(),
);

import { readAppointmentDetail } from "../../../lib/data/appointment-detail";
import {
  presentationNames,
  toPresentationInput,
} from "../../../lib/appointments/presentation-input";
import { deriveBookingPresentation } from "../../../lib/dashboard/money-state";
import { handlePaymentSuccess } from "../../../lib/payments/webhooks/handlers";
import { cleanupExpiredApprovalPendingPayments } from "../../../scripts/payments/cleanup-abandoned-payments";
import { refundDoor } from "./harness-edges";

/** An approved request whose pay link closed five minutes ago, its time still free. */
async function lapsedApproval() {
  const startsAt = futureAt(4, 10);
  return seedOneToOne(
    "consultation",
    await seedHost(),
    await seedConsultee(),
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: "APPROVED_PENDING_PAYMENT",
      bookingSource: "REQUEST_SUBMITTED",
      isTentative: true,
      payment: {
        status: "PENDING",
        expiresAt: new Date(Date.now() - 5 * 60_000),
      },
    },
  );
}

async function learnerMoneyLine(appointmentId: string) {
  const detail = await readAppointmentDetail(appointmentId);
  if (!detail) throw new Error("no booking");
  return deriveBookingPresentation(
    toPresentationInput(detail, {
      viewerId: "learner",
      names: presentationNames(detail, {
        role: "consultee",
        name: "Charlotte",
      }),
      sponsorOrgName: null,
    }),
    "CONSULTEE",
    { viewerZone: "UTC" },
  ).moneyState.line;
}

async function capture(request: Awaited<ReturnType<typeof lapsedApproval>>) {
  return handlePaymentSuccess(
    request.payment!.paymentIntent,
    request.captureMetadata,
    Number(request.payment!.amount),
  );
}

describe("the money line matches what a late capture does", () => {
  beforeEach(() => refundDoor.refundBookingPayment.mockClear());

  it("a PENDING order past its window promises no refund, and its capture confirms the booking", async () => {
    const request = await lapsedApproval();

    const line = await learnerMoneyLine(request.appointmentId);
    expect(line).toContain(
      "If your payment still goes through, the booking is confirmed while the time can still be booked",
    );
    expect(line).not.toContain("If you were charged");

    await capture(request);

    const row = await prisma.consultation.findUniqueOrThrow({
      where: { id: request.consultationId! },
      select: { status: true },
    });
    expect(row.status).toBe("APPROVED");
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: request.payment!.id },
      select: { paymentStatus: true },
    });
    expect(payment.paymentStatus).toBe("SUCCEEDED");
    expect(refundDoor.refundBookingPayment).not.toHaveBeenCalled();
  }, 30_000);

  it("an order the expiry sweep claimed promises the refund, and its capture is refunded", async () => {
    const request = await lapsedApproval();
    expect((await cleanupExpiredApprovalPendingPayments()).errors).toEqual([]);

    expect(await learnerMoneyLine(request.appointmentId)).toContain(
      "If you were charged, the money is refunded automatically.",
    );

    expect(await capture(request)).toBe("captured_after_release");

    const row = await prisma.consultation.findUniqueOrThrow({
      where: { id: request.consultationId! },
      select: { status: true },
    });
    expect(row.status).toBe("EXPIRED");
    expect(refundDoor.refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: request.payment!.id }),
    );
  }, 30_000);
});
