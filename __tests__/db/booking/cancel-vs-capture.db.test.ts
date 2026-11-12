/**
 * Cancel × capture on one unpaid booking. The cancel's request CAS is pinned
 * to the status it read, and its own commit expires the live payment, so:
 *  - a capture that commits after the cancel's read makes the cancel re-quote
 *    (409 REFUND_QUOTE_CHANGED), never cancel a paid booking without a refund;
 *  - a capture that lands after the cancel commits finds EXPIRED and is parked
 *    for an auto-refund;
 *  - a click made on an unpaid screen never cancels a booking that has since
 *    been paid, and a retired payment never reads as a capture.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { seedUser } from "../seed";
import {
  gate,
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
  untilLockWaiter,
} from "./harness";

const readGate = { current: null as ReturnType<typeof gate> | null };
jest.mock("../../../lib/booking/cancellation-scope", () => {
  const actual = jest.requireActual("../../../lib/booking/cancellation-scope");
  return {
    ...actual,
    resolveBookingRefundContext: async (...args: unknown[]) => {
      const ctx = await actual.resolveBookingRefundContext(...args);
      const g = readGate.current;
      if (g) {
        readGate.current = null;
        await g.park();
      }
      return ctx;
    },
  };
});

/** Parks the first request CAS after the cancel's capture probe, before its write. */
const casGate = { current: null as ReturnType<typeof gate> | null };
jest.mock("../../../lib/booking/transitions", () => {
  const actual = jest.requireActual("../../../lib/booking/transitions");
  return {
    ...actual,
    transitionConsultationRequest: async (...args: unknown[]) => {
      const g = casGate.current;
      if (g) {
        casGate.current = null;
        await g.park();
      }
      return actual.transitionConsultationRequest(...args);
    },
  };
});

/** Parks the cancel right after it expired the live payment, row lock held. */
const expiryGate = { current: null as ReturnType<typeof gate> | null };
jest.mock("../../../lib/booking/pending-payment-expiry", () => {
  const actual = jest.requireActual(
    "../../../lib/booking/pending-payment-expiry",
  );
  return {
    ...actual,
    expirePendingPaymentsInTx: async (...args: unknown[]) => {
      const out = await actual.expirePendingPaymentsInTx(...args);
      const g = expiryGate.current;
      if (g) {
        expiryGate.current = null;
        await g.park();
      }
      return out;
    },
  };
});

const sessionUser = { current: null as null | Record<string, unknown> };
jest.mock("../../../lib/auth-helpers", () => ({
  ...jest.requireActual("../../../lib/auth-helpers"),
  requireApiAuth: async () => ({ session: { user: sessionUser.current } }),
  isPrivileged: () => false,
}));
jest.mock("../../../lib/rate-limit", () =>
  jest.requireActual("./harness-edges").rateLimitMock(),
);
// Every bell is a no-op: notifications are outside the race under test.
jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/stream/access-revocation", () =>
  jest.requireActual("./harness-edges").chatRevocationMock(),
);

import { POST as cancel } from "../../../app/api/appointments/[appointmentId]/cancel/route";
import { handlePaymentSuccess } from "../../../lib/payments/webhooks/handlers";

async function seedUnpaidApproval(
  payment: { status: "PENDING" } | null = { status: "PENDING" },
) {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const startsAt = futureAt(4, 9);
  const booking = await seedOneToOne(
    "consultation",
    host,
    buyer,
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: "APPROVED_PENDING_PAYMENT",
      bookingSource: "REQUEST_SUBMITTED",
      isTentative: true,
      payment: payment ?? undefined,
    },
  );
  sessionUser.current = {
    id: buyer.userId,
    role: "CONSULTEE",
    consulteeProfileId: buyer.consulteeProfileId,
    consultantProfileId: null,
    name: "Buyer",
  };
  return { host, buyer, booking, payment: booking.payment! };
}

/** A payment row committed outside the cancel: the legs trigger needs its split in the same commit. */
function paymentData(
  appointmentId: string,
  userId: string,
  status: "SUCCEEDED" | "PENDING",
) {
  return {
    amount: BigInt(100_000),
    originalAmount: BigInt(100_000),
    paymentMethod: "card",
    paymentIntent: `order_dbtier_${randomUUID()}`,
    paymentGateway: "RAZORPAY" as const,
    paymentStatus: status,
    userId,
    appointmentId,
    isMockPayment: true,
    legs: {
      create: [{ source: "CARD" as const, amountPaise: BigInt(100_000) }],
    },
  };
}

const cancelRequest = (
  appointmentId: string,
  click: Record<string, unknown> = {},
) =>
  cancel(
    new NextRequest(
      `http://localhost/api/appointments/${appointmentId}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ reason: "SCHEDULE_CONFLICT", ...click }),
        headers: { "Content-Type": "application/json" },
      },
    ),
    { params: Promise.resolve({ appointmentId }) },
  );

const capture = (
  payment: { paymentIntent: string; amount: number | bigint },
  metadata: Record<string, string>,
) =>
  handlePaymentSuccess(payment.paymentIntent, metadata, Number(payment.amount));

async function finalState(consultationId: string, paymentId: string) {
  const [consultation, payment, refunds] = await Promise.all([
    prisma.consultation.findUniqueOrThrow({ where: { id: consultationId } }),
    prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }),
    prisma.refund.count({ where: { paymentId } }),
  ]);
  return { consultation, payment, refunds };
}

const refundDoor = jest.requireMock(
  "../../../lib/payments/operations/booking-refund",
) as { refundBookingPayment: jest.Mock };

/** Never a cancelled booking holding captured money with nothing owed back. */
function expectNoSilentKeep(state: Awaited<ReturnType<typeof finalState>>) {
  const cancelledAndPaid =
    state.consultation.status === "CANCELLED" &&
    state.payment.paymentStatus === "SUCCEEDED";
  if (cancelledAndPaid) {
    const refundDriven = refundDoor.refundBookingPayment.mock.calls.some(
      ([args]) =>
        (args as { paymentId: string }).paymentId === state.payment.id,
    );
    const owed =
      state.payment.refundOwedKey !== null ||
      (state.payment.description ?? "").startsWith("Auto-refund pending:") ||
      state.refunds > 0 ||
      refundDriven;
    expect(owed).toBe(true);
  }
}

describe("cancel × capture", () => {
  it("a capture committing under the cancel's read turns the cancel into a re-quote", async () => {
    const { booking, payment } = await seedUnpaidApproval();
    const paused = gate();
    readGate.current = paused;

    const cancelling = cancelRequest(booking.appointmentId);
    await paused.arrived;
    await capture(payment, booking.captureMetadata);
    paused.open();
    const res = await cancelling;

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("REFUND_QUOTE_CHANGED");
    const state = await finalState(booking.consultationId!, payment.id);
    expect(state.consultation.status).not.toBe("CANCELLED");
    expect(state.payment.paymentStatus).toBe("SUCCEEDED");
    expectNoSilentKeep(state);
  });

  it("a capture landing after the cancel commits is parked for a refund", async () => {
    const { booking, payment } = await seedUnpaidApproval();

    const res = await cancelRequest(booking.appointmentId);
    expect(res.status).toBe(200);
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }))
        .paymentStatus,
    ).toBe("EXPIRED");

    await capture(payment, booking.captureMetadata);

    const state = await finalState(booking.consultationId!, payment.id);
    expect(state.consultation.status).toBe("CANCELLED");
    expect(state.payment.paymentStatus).toBe("SUCCEEDED");
    expectNoSilentKeep(state);
  });

  it("a payment committing between the probe and the CAS re-quotes through the pinned CAS", async () => {
    // No payment row yet, so the cancel's expiry locks nothing and its probe
    // counts zero; a no-gateway rail then pays and confirms under its feet.
    const { booking, buyer } = await seedUnpaidApproval(null);
    const paused = gate();
    casGate.current = paused;

    const cancelling = cancelRequest(booking.appointmentId, {
      expectedRefundPaise: 0,
      expectedPaid: false,
    });
    await paused.arrived;
    const paid = await prisma.$transaction(async (tx) => {
      const row = await tx.payment.create({
        data: paymentData(booking.appointmentId, buyer.userId, "SUCCEEDED"),
      });
      await tx.consultation.update({
        where: { id: booking.consultationId! },
        data: { status: "APPROVED" },
      });
      return row;
    });
    paused.open();
    const res = await cancelling;

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("REFUND_QUOTE_CHANGED");
    const state = await finalState(booking.consultationId!, paid.id);
    expect(state.consultation.status).toBe("APPROVED");
    expectNoSilentKeep(state);
  });

  it("a cancel that expired the payment first makes the blocked capture land on EXPIRED", async () => {
    const { booking, payment } = await seedUnpaidApproval();
    const paused = gate();
    expiryGate.current = paused;

    const cancelling = cancelRequest(booking.appointmentId);
    await paused.arrived;
    // The capture blocks on the payment row the cancel holds, then retries.
    const capturing = capture(payment, booking.captureMetadata);
    await untilLockWaiter();
    paused.open();
    const res = await cancelling;
    await capturing;

    expect(res.status).toBe(200);
    const state = await finalState(booking.consultationId!, payment.id);
    expect(state.consultation.status).toBe("CANCELLED");
    expect(state.payment.paymentStatus).toBe("SUCCEEDED");
    expectNoSilentKeep(state);
  });

  it("a click made on the unpaid screen after the capture committed is re-quoted, never cancelled at the policy tier", async () => {
    const { booking, payment } = await seedUnpaidApproval();
    await capture(payment, booking.captureMetadata);

    const res = await cancelRequest(booking.appointmentId, {
      expectedRefundPaise: 0,
      expectedPaid: false,
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("REFUND_QUOTE_CHANGED");
    expect(body.error).toMatch(/payment just went through/i);
    const state = await finalState(booking.consultationId!, payment.id);
    expect(state.consultation.status).not.toBe("CANCELLED");
    expect(state.payment.paymentStatus).toBe("SUCCEEDED");
  });

  it("a retired SUCCEEDED payment on the booking does not read as a capture", async () => {
    const { booking, payment } = await seedUnpaidApproval();
    const other = await seedUser("CONSULTEE");
    await prisma.payment.create({
      data: {
        ...paymentData(booking.appointmentId, other.userId, "SUCCEEDED"),
        deletedAt: new Date(),
      },
    });

    const res = await cancelRequest(booking.appointmentId, {
      expectedRefundPaise: 0,
      expectedPaid: false,
    });

    expect(res.status).toBe(200);
    const state = await finalState(booking.consultationId!, payment.id);
    expect(state.consultation.status).toBe("CANCELLED");
    expect(state.payment.paymentStatus).toBe("EXPIRED");
  });
});
