/**
 * @jest-environment node
 */

/**
 * The payment write for a rejoin: only an order that is still price-free
 * revives a left free seat on its earlier payment, and it answers with that
 * payment's own stored intent, never a fresh one stored nowhere.
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import type { Tx } from "@/lib/prisma";
import { writeCheckoutPayment } from "@/lib/payments/checkout/commit/payment-row";
import type { CheckoutCommitInput } from "@/lib/payments/checkout/commit/types";
import type { PriorSeatPayment } from "@/lib/payments/checkout/seats";

// The row `findPriorSeatPayment` selects for a free seat its holder left.
const leftFreeSeat: PriorSeatPayment = {
  id: "pay-free",
  userId: "u-1",
  paymentIntent: "free_first_registration",
  gatewayPaymentId: null,
  amount: 0,
  originalAmount: 0,
  taxAmount: 0,
  gstRegime: null,
  currency: "INR",
  paymentGateway: "RAZORPAY",
  paymentStatus: "SUCCEEDED",
  refunds: [],
  appointmentParticipants: [{ status: "CANCELLED", removedByUserId: null }],
};

const linkSeat = jest.fn(async () => ({ count: 1 }));
const tx = {
  appointmentParticipant: { updateMany: linkSeat },
  appointmentWaitlist: { updateMany: jest.fn(async () => ({ count: 0 })) },
} as unknown as Tx;

/** A zero-amount webinar order; `listPaise` is what the event costs today. */
const order = (listPaise: number) =>
  ({
    validatedData: {
      appointmentType: "WEBINAR",
      planId: "plan-1",
      eventId: "web-1",
      paymentGateway: "RAZORPAY",
    },
    userId: "u-1",
    isMockPayment: false,
    mintedOrder: { id: "free_minted_now", client_secret: null },
    holdExpiresAt: new Date("2030-01-01T00:00:00Z"),
    organizationId: null,
    billingAccountId: null,
    isOrgWalletPayment: false,
    isOrgInvoicedPayment: false,
    isOrgLicensedPayment: false,
    isOrgSponsoredPayment: false,
    isZeroAmountPayment: true,
    displayCurrencyAtCheckout: "INR",
    exchangeRateAtCheckout: null,
    priced: { amount: 0, originalAmount: listPaise, currency: "INR" },
  }) as unknown as CheckoutCommitInput;

const write = (listPaise: number) =>
  writeCheckoutPayment(tx, order(listPaise), {
    createdAppointment: { id: "appt-1" },
    bookedPlan: null,
    skipPayment: true,
    priorSeat: leftFreeSeat,
  });

it("revives the left free seat on its earlier payment and names that payment's stored intent", async () => {
  await expect(write(0)).resolves.toEqual({
    id: "pay-free",
    amount: 0,
    expiresAt: null,
    rejoined: true,
    reusedPaymentIntent: "free_first_registration",
  });
});

it("refuses a rejoin once the event has a price, even when credits bring the order to ₹0", async () => {
  await expect(write(50_000)).rejects.toMatchObject({
    code: "SEAT_REBUY_UNSUPPORTED",
    message: expect.stringMatching(/left this event/),
  });
  expect(linkSeat).not.toHaveBeenCalled();
});
