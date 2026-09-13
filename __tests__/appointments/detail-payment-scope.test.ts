/**
 * A webinar's attendees each carry a Payment on the same appointment. The
 * host reads a status per seat; an attendee must receive only their own
 * rows. Pins the scoping and the per-seat ranking the roster relies on.
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  scopeAppointmentDetail,
  type TAppointmentDetail,
} from "@/lib/data/appointment-detail";
import {
  paymentDisplayStatus,
  seatPaymentsByUser,
  summarizeSeatPayments,
} from "@/lib/appointments/seat-payments";
import {
  paymentFunding,
  paymentRailLabel,
  receiptHref,
} from "@/lib/appointments/payment-display";

const HOST = "u-host";
const A = "u-a";
const B = "u-b";

const detail = {
  appointment: {
    id: "appt",
    organizationId: null,
    webinarId: "web-1",
    classId: null,
    webinar: { webinarPlan: { consultantProfile: { userId: HOST } } },
    slotsOfAppointment: [
      {
        user: [
          { id: A, name: "A", image: null },
          { id: B, name: "B", image: null },
        ],
      },
    ],
    payment: [
      {
        id: "p-a",
        userId: A,
        paymentStatus: "SUCCEEDED",
        amount: "324270",
        currency: "INR",
        createdAt: "2026-09-12T00:00:00Z",
        expiresAt: null,
        receiptUrl: null,
        consumerInvoice: { id: "inv-a" },
        childPayments: [
          { id: "p-a-overage", userId: A, consumerInvoice: { id: "inv-a2" } },
        ],
      },
      {
        id: "p-b",
        userId: B,
        paymentStatus: "EXPIRED",
        amount: "274805",
        currency: "INR",
        createdAt: "2026-09-10T00:00:00Z",
        expiresAt: null,
        receiptUrl: null,
        consumerInvoice: null,
        childPayments: [],
      },
    ],
  },
  siblings: [],
} as unknown as TAppointmentDetail;

describe("scopeAppointmentDetail", () => {
  it("gives an attendee only their own payment rows", () => {
    const scoped = scopeAppointmentDetail(detail, A);
    expect(scoped.appointment.payment.map((p) => p.id)).toEqual(["p-a"]);
  });

  it("leaves a 1:1 booking whole for its attendee, whoever paid", () => {
    // A sponsored consultation: the Payment's userId is the org admin's, and
    // the attending consultee must still see the booking's payment.
    const consultation = {
      appointment: {
        id: "appt-1to1",
        organizationId: "org-1",
        webinarId: null,
        classId: null,
        consultation: {
          consultationPlan: { consultantProfile: { userId: HOST } },
          requestedBy: { userId: A },
        },
        slotsOfAppointment: [],
        payment: [
          {
            id: "p-sponsor",
            userId: "u-org-admin",
            paymentStatus: "SUCCEEDED",
            amount: "840865",
            currency: "INR",
            createdAt: "2026-09-12T00:00:00Z",
            expiresAt: null,
            childPayments: [],
          },
        ],
      },
      siblings: [],
    } as unknown as TAppointmentDetail;
    expect(
      scopeAppointmentDetail(consultation, A).appointment.payment,
    ).toHaveLength(1);
  });

  it("leaves the host's and staff's view whole", () => {
    expect(
      scopeAppointmentDetail(detail, HOST).appointment.payment,
    ).toHaveLength(2);
    expect(
      scopeAppointmentDetail(detail, "u-staff", true).appointment.payment,
    ).toHaveLength(2);
  });

  it("keeps a receipt only on the payer's own rows, and on staff's", () => {
    const host = scopeAppointmentDetail(detail, HOST).appointment.payment[0];
    expect(host.consumerInvoice).toBeNull();
    expect(host.childPayments[0].consumerInvoice).toBeNull();
    const own = scopeAppointmentDetail(detail, A).appointment.payment[0];
    expect(own.consumerInvoice).toEqual({ id: "inv-a" });
    const staff = scopeAppointmentDetail(detail, "u-staff", true).appointment
      .payment[0];
    expect(staff.consumerInvoice).toEqual({ id: "inv-a" });
  });
});

describe("payment display", () => {
  const row = {
    id: "p",
    paymentStatus: "SUCCEEDED",
    paymentMethod: "CARD",
    paymentGateway: "RAZORPAY",
    receiptUrl: null,
    consumerInvoice: null,
  };

  it("reads sponsorship off the funding legs, then off the method", () => {
    expect(paymentFunding({ ...row, legs: [{ source: "WALLET" }] })).toBe(
      "ORG",
    );
    expect(paymentFunding({ ...row, legs: [{ source: "CARD" }] })).toBe("SELF");
    expect(
      paymentFunding({
        ...row,
        legs: [{ source: "CARD" }, { source: "REFERRAL_CREDIT" }],
      }),
    ).toBe("SELF");
    expect(paymentFunding({ ...row, paymentMethod: "INVOICE" })).toBe("ORG");
    // An org-tagged PERSONAL booking: the member paid their own card.
    expect(paymentFunding({ ...row, legs: [] })).toBe("SELF");
    expect(paymentFunding({ ...row, paymentMethod: "credit_card" })).toBe(
      "SELF",
    );
  });

  it("names the gateway, not an instrument it never recorded", () => {
    expect(paymentRailLabel(row)).toBe("Razorpay");
    expect(paymentRailLabel({ ...row, paymentMethod: "LICENSE" })).toBe(
      "organisation licence",
    );
    expect(paymentRailLabel({ ...row, paymentGateway: "CARD" })).toBeNull();
  });

  it("links the tax invoice first, the gateway receipt second, nothing unpaid", () => {
    expect(receiptHref({ ...row, consumerInvoice: { id: "i" } })).toBe(
      "/api/payments/p/invoice/pdf",
    );
    expect(receiptHref({ ...row, receiptUrl: "https://rzp.io/r/x" })).toBe(
      "https://rzp.io/r/x",
    );
    expect(
      receiptHref({ ...row, receiptUrl: "javascript:alert(1)" }),
    ).toBeNull();
    expect(
      receiptHref({
        ...row,
        paymentStatus: "PENDING",
        consumerInvoice: { id: "i" },
      }),
    ).toBeNull();
  });
});

describe("seat payments", () => {
  it("lets a paid row speak for a seat over a lapsed one, then the newest", () => {
    const byUser = seatPaymentsByUser([
      {
        userId: A,
        paymentStatus: "EXPIRED",
        amount: 1,
        currency: "INR",
        createdAt: "2026-09-12T00:00:00Z",
      },
      {
        userId: A,
        paymentStatus: "SUCCEEDED",
        amount: 2,
        currency: "INR",
        createdAt: "2026-09-01T00:00:00Z",
      },
      {
        userId: B,
        paymentStatus: "PENDING",
        amount: 3,
        currency: "INR",
        createdAt: "2026-09-01T00:00:00Z",
      },
      {
        userId: B,
        paymentStatus: "PENDING",
        amount: 4,
        currency: "INR",
        createdAt: "2026-09-02T00:00:00Z",
      },
    ]);
    expect(Number(byUser.get(A)?.amount)).toBe(2);
    expect(Number(byUser.get(B)?.amount)).toBe(4);
    expect(summarizeSeatPayments(byUser)).toEqual({
      paid: 1,
      pending: 1,
      lapsed: 0,
      refunded: 0,
      collectedPaise: 2,
      currency: "INR",
      otherCurrency: 0,
    });
  });

  it("counts a zero-amount seat as paid and never adds paise of two currencies", () => {
    const inr = {
      userId: A,
      paymentStatus: "SUCCEEDED",
      amount: 0,
      currency: "INR",
      createdAt: "2026-09-01T00:00:00Z",
    };
    const usd = {
      userId: B,
      paymentStatus: "SUCCEEDED",
      amount: 500,
      currency: "USD",
      createdAt: "2026-09-01T00:00:00Z",
    };
    // An appointment settles in the plan's currency (ADR 15); a row that
    // breaks that is counted, not summed — whichever row comes first.
    const expected = {
      paid: 2,
      pending: 0,
      lapsed: 0,
      refunded: 0,
      collectedPaise: 0,
      currency: "INR",
      otherCurrency: 1,
    };
    expect(
      summarizeSeatPayments(seatPaymentsByUser([inr, usd]), "INR"),
    ).toEqual(expected);
    expect(
      summarizeSeatPayments(seatPaymentsByUser([usd, inr]), "INR"),
    ).toEqual(expected);
  });

  it("derives the refund state and nets it out of what was collected", () => {
    const full = {
      userId: A,
      paymentStatus: "SUCCEEDED",
      amount: 1000,
      currency: "INR",
      createdAt: "2026-09-01T00:00:00Z",
      refunds: [{ amountPaise: 1000 }],
    };
    const partial = {
      userId: B,
      paymentStatus: "SUCCEEDED",
      amount: 1000,
      currency: "INR",
      createdAt: "2026-09-01T00:00:00Z",
      refunds: [{ amountPaise: 250 }, { amountPaise: 100, status: "FAILED" }],
    };
    expect(paymentDisplayStatus(full)).toBe("REFUNDED");
    expect(paymentDisplayStatus(partial)).toBe("PARTIALLY_REFUNDED");
    // A refund on a PENDING row is not a refund of a capture.
    expect(paymentDisplayStatus({ ...full, paymentStatus: "PENDING" })).toBe(
      "PENDING",
    );
    // A newer PENDING row (a rebooking) speaks for the seat over the refund;
    // an OLDER abandoned hold does not outrank a newer refund.
    const rebooked = {
      ...full,
      paymentStatus: "PENDING",
      refunds: [],
      createdAt: "2026-09-02T00:00:00Z",
    };
    expect(seatPaymentsByUser([full, rebooked]).get(A)).toBe(rebooked);
    const abandoned = { ...rebooked, createdAt: "2026-08-01T00:00:00Z" };
    expect(seatPaymentsByUser([abandoned, full]).get(A)).toBe(full);
    expect(summarizeSeatPayments(seatPaymentsByUser([full, partial]))).toEqual({
      paid: 1,
      pending: 0,
      lapsed: 0,
      refunded: 1,
      collectedPaise: 750,
      currency: "INR",
      otherCurrency: 0,
    });
  });
});
