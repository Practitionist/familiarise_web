/**
 * @jest-environment node
 */

/**
 * A ₹0 booking is free: it is never described as funded by referral credit and
 * never shows a refund step. A booking really paid in referral credit keeps its
 * credit wording.
 */

import {
  FREE_BOOKING_REFUND_LINE,
  isFreePayment,
  refundRailLine,
} from "@/lib/appointments/payment-display";
import {
  deriveBookingPresentation,
  type BookingPresentationInput,
  type PaymentInput,
} from "@/lib/dashboard/money-state";

const NOW = new Date("2026-11-13T09:12:00Z");

const amounts = {
  estimatedRefundPaise: 0,
  currency: "INR",
  refundPct: 100,
  prorated: false,
};

describe("refundRailLine for a free booking", () => {
  it("says there is nothing to refund and never mentions credits", () => {
    const line = refundRailLine("CREDITS", { ...amounts, freeBooking: true });
    expect(line).toBe(FREE_BOOKING_REFUND_LINE);
    expect(line).not.toMatch(/credit|restored|refunded/i);
  });

  it("keeps the credit wording for a booking paid in referral credit", () => {
    expect(refundRailLine("CREDITS", { ...amounts, freeBooking: false })).toBe(
      "You paid with referral credits — they'll be restored to your balance.",
    );
    expect(refundRailLine("CREDITS", amounts)).toContain("referral credits");
  });
});

const payment = (over: Partial<PaymentInput>): PaymentInput => ({
  id: "p1",
  paymentStatus: "SUCCEEDED",
  paymentMethod: "CREDITS",
  paymentGateway: "RAZORPAY",
  receiptUrl: null,
  consumerInvoice: null,
  amount: 0,
  currency: "INR",
  createdAt: NOW,
  legs: [],
  ...over,
});

describe("isFreePayment", () => {
  it("is true for ₹0 with no credit leg, false once a credit leg carries value", () => {
    expect(isFreePayment(payment({}))).toBe(true);
    expect(
      isFreePayment(
        payment({ legs: [{ source: "REFERRAL_CREDIT", amountPaise: 50_000 }] }),
      ),
    ).toBe(false);
    expect(isFreePayment(payment({ amount: 50_000 }))).toBe(false);
    expect(isFreePayment(payment({ legs: undefined }))).toBe(false);
    expect(isFreePayment(payment({ paymentMethod: "WALLET" }))).toBe(false);
  });
});

describe("the refund step on a ₹0 booking", () => {
  const stepsFor = (p: PaymentInput) =>
    deriveBookingPresentation(
      {
        appointmentType: "CONSULTATION",
        request: null,
        occurrences: [],
        payments: [p],
        refunds: [
          {
            status: "SUCCEEDED",
            amountPaise: 0,
            refundId: "credits_1",
            createdAt: NOW,
          },
        ],
        disputes: [],
        childPayments: [],
        sponsorOrgName: null,
        holdExpiresAt: null,
        names: { payer: "Rachel", consultant: "Ethan" },
      } as BookingPresentationInput,
      "CONSULTEE",
      { viewerZone: "UTC", now: NOW },
    ).timeline.filter((e) => e.kind === "refund-completed");

  it("shows no Refunded step for a free booking", () => {
    expect(stepsFor(payment({}))).toEqual([]);
  });

  it("keeps the Refunded step when referral credit paid for it", () => {
    const steps = stepsFor(
      payment({ legs: [{ source: "REFERRAL_CREDIT", amountPaise: 50_000 }] }),
    );
    expect(steps.map((s) => s.label)).toEqual(["Refunded"]);
  });
});
