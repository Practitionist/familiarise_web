/**
 * @jest-environment node
 */

/** "Problem with this charge" only where money was actually taken from the viewer. */

import { viewerWasCharged } from "@/lib/appointments/payment-display";

const sponsoredRow = {
  paymentStatus: "SUCCEEDED",
  amount: 250_000,
  paymentMethod: "WALLET",
  legs: [{ source: "WALLET", amountPaise: 250_000 }],
  childPayments: [
    // A CHARGE_ORG overage child: the organisation's charge, written for the member.
    {
      userId: "member-1",
      paymentStatus: "SUCCEEDED",
      amount: 50_000,
      paymentMethod: "WALLET",
      legs: [{ source: "WALLET", amountPaise: 50_000 }],
    },
  ],
};

describe("viewerWasCharged", () => {
  it("a sponsored booking with an organisation-paid overage is not the member's charge", () => {
    expect(viewerWasCharged("SPONSORED", [sponsoredRow], "member-1")).toBe(
      false,
    );
  });

  it("a member's own co-pay on a sponsored booking is their charge", () => {
    const coPay = {
      ...sponsoredRow,
      childPayments: [
        {
          userId: "member-1",
          paymentStatus: "SUCCEEDED",
          amount: 50_000,
          paymentMethod: "RAZORPAY",
          legs: [{ source: "CARD", amountPaise: 50_000 }],
        },
      ],
    };
    expect(viewerWasCharged("SPONSORED", [coPay], "member-1")).toBe(true);
  });

  it.each(["PAID", "PARTIALLY_REFUNDED", "REFUND_PENDING", "REFUNDED", "DISPUTED"] as const)(
    "%s is money taken",
    (state) => {
      expect(viewerWasCharged(state, [], "member-1")).toBe(true);
    },
  );

  it.each(["FREE", "NOT_DUE", "DUE"] as const)("%s is not", (state) => {
    expect(viewerWasCharged(state, [], "member-1")).toBe(false);
  });
});
