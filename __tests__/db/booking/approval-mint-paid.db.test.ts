/**
 * A pay-link mint for a request whose payment already succeeded answers
 * "already paid", never "the window lapsed"; a request that ended unpaid
 * still refuses as lapsed.
 */
import { futureAt, seedConsultee, seedHost, seedOneToOne } from "./harness";

jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(async () => {
    throw new Error("the gateway must not be called");
  }),
  cancelPaymentIntent: jest.fn(async () => undefined),
}));

import {
  ApprovalAlreadyPaidError,
  ApprovalWindowLapsedError,
  createApprovalPaymentIntent,
} from "../../../lib/payments/operations/approval-payment";

async function mintFor(shape: Parameters<typeof seedOneToOne>[4]) {
  const host = await seedHost();
  const consultee = await seedConsultee();
  const booking = await seedOneToOne(
    "consultation",
    host,
    consultee,
    { startsAt: futureAt(6, 9), endsAt: futureAt(6, 10) },
    shape,
  );
  return createApprovalPaymentIntent({
    userId: consultee.userId,
    appointmentType: "CONSULTATION",
    consultationId: booking.consultationId!,
    planId: booking.planId,
    appointmentId: booking.appointmentId,
    paymentGateway: "RAZORPAY",
  }).then(
    () => "minted" as const,
    (error: unknown) => error,
  );
}

describe("approval mint after a capture", () => {
  it("answers already paid for an APPROVED request with a SUCCEEDED payment", async () => {
    const outcome = await mintFor({
      status: "APPROVED",
      bookingSource: "REQUEST_SUBMITTED",
      isTentative: false,
      payment: { status: "SUCCEEDED", expiresAt: null },
    });
    expect(outcome).toBeInstanceOf(ApprovalAlreadyPaidError);
  });

  it("still refuses a cancelled request with a pending payment as lapsed", async () => {
    const outcome = await mintFor({
      status: "CANCELLED",
      bookingSource: "REQUEST_SUBMITTED",
      isTentative: true,
      payment: { status: "PENDING", expiresAt: new Date(Date.now() + 60_000) },
    });
    expect(outcome).toBeInstanceOf(ApprovalWindowLapsedError);
  });

  it("still refuses an expired request with no payment as lapsed", async () => {
    const outcome = await mintFor({
      status: "EXPIRED",
      bookingSource: "REQUEST_SUBMITTED",
      isTentative: true,
    });
    expect(outcome).toBeInstanceOf(ApprovalWindowLapsedError);
  });
});
