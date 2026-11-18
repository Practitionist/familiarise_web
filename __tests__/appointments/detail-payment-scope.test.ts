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
import { managesGroupPlanAsNamedExpert } from "@/lib/enterprise/membership-guards";
import type { PrismaLike } from "@/lib/prisma";
import {
  paymentDisplayStatus,
  seatPaymentsByUser,
  summarizeSeatPayments,
} from "@/lib/appointments/seat-payments";
import {
  formatFundingBreakdown,
  paymentFunding,
  paymentFundingBreakdown,
  paymentRailLabel,
  receiptHref,
  refundRailLine,
} from "@/lib/appointments/payment-display";

const HOST = "u-host";
const A = "u-a";
const B = "u-b";
const PRESENTER = "u-presenter";
const CREW = "u-crew";

const detail = {
  appointment: {
    id: "appt",
    organizationId: null,
    webinarId: "web-1",
    classId: null,
    webinar: {
      webinarPlan: {
        consultantProfile: { userId: HOST },
        collaborators: [
          { tier: "PRESENTER", consultantProfile: { userId: PRESENTER } },
          { tier: "CREW", consultantProfile: { userId: CREW } },
        ],
      },
    },
    occurrences: [{}],
    participants: [
      { userId: A, role: "CONSULTEE", user: { id: A, name: "A", image: null } },
      { userId: B, role: "CONSULTEE", user: { id: B, name: "B", image: null } },
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

/** A viewer who does not manage the plan: an attendee, a collaborator, a payer. */
const attendee = (userId: string) => ({ userId, managesGroupPlan: false });
const MANAGING_EXPERT = { userId: HOST, managesGroupPlan: true };
const STAFF = { userId: "u-staff", privileged: true, managesGroupPlan: false };

describe("scopeAppointmentDetail", () => {
  it("gives an attendee only their own payment rows", () => {
    const scoped = scopeAppointmentDetail(detail, attendee(A));
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
        occurrences: [],
        participants: [],
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
      scopeAppointmentDetail(consultation, attendee(A)).appointment.payment,
    ).toHaveLength(1);
  });

  it("leaves the host's and staff's view whole", () => {
    expect(
      scopeAppointmentDetail(detail, MANAGING_EXPERT).appointment.payment,
    ).toHaveLength(2);
    expect(
      scopeAppointmentDetail(detail, STAFF).appointment.payment,
    ).toHaveLength(2);
  });

  it("gives a presenter every seat and no attendee's payment, and crew neither", () => {
    const presenter = scopeAppointmentDetail(
      detail,
      attendee(PRESENTER),
    ).appointment;
    expect(presenter.participants.map((p) => p.userId)).toEqual([A, B]);
    expect(presenter.payment).toEqual([]);
    const crew = scopeAppointmentDetail(detail, attendee(CREW)).appointment;
    expect(crew.participants).toEqual([]);
    expect(crew.payment).toEqual([]);
  });

  it("says which of the roster and the payments each viewer is shown", () => {
    const shown = (viewer: Parameters<typeof scopeAppointmentDetail>[1]) => {
      const { rosterVisible, paymentsVisible } = scopeAppointmentDetail(
        detail,
        viewer,
      );
      return { rosterVisible, paymentsVisible };
    };
    const both = { rosterVisible: true, paymentsVisible: true };
    expect(shown(MANAGING_EXPERT)).toEqual(both);
    expect(shown(STAFF)).toEqual(both);
    expect(shown(attendee(PRESENTER))).toEqual({
      rosterVisible: true,
      paymentsVisible: false,
    });
    expect(shown(attendee(CREW))).toEqual({
      rosterVisible: false,
      paymentsVisible: false,
    });
  });

  it("gives the named expert who no longer manages the plan no attendee's seat or payment", () => {
    const lapsed = scopeAppointmentDetail(detail, attendee(HOST)).appointment;
    expect(lapsed.participants).toEqual([]);
    expect(lapsed.payment).toEqual([]);
  });

  it("keeps a receipt only on the payer's own rows, and on staff's", () => {
    const host = scopeAppointmentDetail(detail, MANAGING_EXPERT).appointment
      .payment[0];
    expect(host.consumerInvoice).toBeNull();
    expect(host.childPayments[0].consumerInvoice).toBeNull();
    const own = scopeAppointmentDetail(detail, attendee(A)).appointment
      .payment[0];
    expect(own.consumerInvoice).toEqual({ id: "inv-a" });
    const staff = scopeAppointmentDetail(detail, STAFF).appointment.payment[0];
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

  type LegCase = [string, string, number, [string, number][], string, string];
  // Leg sets as their writers leave them; Payment.amount excludes REFERRAL_CREDIT.
  it.each<LegCase>([
    [
      "card + referral credit",
      "CARD",
      80_000,
      [
        ["CARD", 80_000],
        ["REFERRAL_CREDIT", 20_000],
      ],
      "Razorpay",
      "₹800.00 card / UPI + ₹200.00 referral credit",
    ],
    [
      "referral credit only",
      "CREDITS",
      0,
      [["REFERRAL_CREDIT", 118_000]],
      "referral credit",
      "₹1,180.00 referral credit",
    ],
    [
      "wallet",
      "WALLET",
      118_000,
      [["WALLET", 118_000]],
      "organisation wallet",
      "₹1,180.00 organisation wallet",
    ],
    [
      "invoice accrual",
      "INVOICE",
      118_000,
      [["INVOICE_ACCRUAL", 118_000]],
      "invoiced to the organisation",
      "₹1,180.00 invoiced to the organisation",
    ],
    [
      "licence",
      "LICENSE",
      118_000,
      [["LICENSE", 0]],
      "organisation licence",
      "₹0.00 organisation licence",
    ],
    [
      "CHARGE_ORG overage child",
      "ENTERPRISE_INVOICE_ACCRUAL",
      23_600,
      [["OVERAGE_INVOICE_ACCRUAL", 23_600]],
      "invoiced to the organisation",
      "₹236.00 invoiced to the organisation",
    ],
    [
      "carved invoice parent",
      "INVOICE",
      141_600,
      [
        ["INVOICE_ACCRUAL", 0],
        ["OVERAGE_INVOICE_ACCRUAL", 141_600],
      ],
      "invoiced to the organisation",
      "₹1,416.00 invoiced to the organisation",
    ],
    [
      "refunded accrual",
      "INVOICE",
      118_000,
      [
        ["INVOICE_ACCRUAL", 118_000],
        ["INVOICE_ACCRUAL_REVERSAL", -50_000],
      ],
      "invoiced to the organisation",
      "₹1,180.00 invoiced to the organisation",
    ],
  ])(
    "%s: rail, breakdown and the leg-sum identity",
    (_, method, amount, legRows, rail, text) => {
      const legs = legRows.map(([source, amountPaise]) => ({
        source,
        amountPaise,
      }));
      const breakdown = paymentFundingBreakdown(legs);
      expect(paymentRailLabel({ ...row, paymentMethod: method, legs })).toBe(
        rail,
      );
      expect(formatFundingBreakdown(breakdown, "INR")).toBe(text);
      const licenceOnly = legs.every((l) => l.source === "LICENSE");
      const funded = breakdown
        .filter((e) => e.source !== "REFERRAL_CREDIT" && e.source !== "LICENSE")
        .reduce((sum, e) => sum + e.amountPaise, 0);
      expect(licenceOnly || funded === amount).toBe(true);
    },
  );

  it("falls back to the method only for a row with no legs", () => {
    expect(paymentFundingBreakdown([])).toEqual([]);
    expect(paymentRailLabel({ ...row, paymentMethod: "INVOICE" })).toBe(
      "invoiced to the organisation",
    );
    expect(paymentRailLabel({ ...row, paymentMethod: "CREDITS" })).toBe(
      "credits",
    );
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

describe("refundRailLine — one sentence per rail (#1675 X6)", () => {
  const amounts = {
    estimatedRefundPaise: 120_000,
    currency: "INR",
    refundPct: 100,
    prorated: false,
  };

  it("names the card, the organisation and the credits differently", () => {
    const gateway = refundRailLine("GATEWAY", amounts);
    const internal = refundRailLine("INTERNAL", amounts);
    const credits = refundRailLine("CREDITS", amounts);
    expect(gateway).toContain("~₹1,200.00");
    expect(gateway).toContain("original payment method");
    expect(internal).toContain("Your organisation is credited ~₹1,200.00");
    expect(internal).toContain("nothing was charged to you");
    expect(credits).toBe(
      "You paid with referral credits — they'll be restored to your balance.",
    );
    expect(new Set([gateway, internal, credits]).size).toBe(3);
    // A partial window never promises the credits back.
    expect(refundRailLine("CREDITS", { ...amounts, refundPct: 50 })).toContain(
      "reviewed manually",
    );
    expect(
      refundRailLine("GATEWAY", { ...amounts, estimatedRefundPaise: 0 }),
    ).toMatch(/^No refund at this notice/);
  });
});

describe("managesGroupPlanAsNamedExpert", () => {
  const count = jest.fn();
  const db = { membership: { count } } as unknown as PrismaLike;
  const booking = (organizationId: string | null) => ({
    webinar: {
      webinarPlan: {
        organizationId,
        consultantProfile: { id: "cp-host", userId: HOST },
      },
    },
    class: null,
  });

  beforeEach(() => count.mockReset());

  it("on an organisation's plan, holds for the named expert only while an active expert of that organisation", async () => {
    count.mockResolvedValue(1);
    await expect(
      managesGroupPlanAsNamedExpert(db, booking("org-1"), HOST),
    ).resolves.toBe(true);
    expect(count).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        consultantProfileId: "cp-host",
        status: "ACTIVE",
        role: "EXPERT",
      },
    });

    count.mockResolvedValue(0);
    await expect(
      managesGroupPlanAsNamedExpert(db, booking("org-1"), HOST),
    ).resolves.toBe(false);
  });

  it("holds on a personal plan and for nobody else, without reading a membership", async () => {
    await expect(
      managesGroupPlanAsNamedExpert(db, booking(null), HOST),
    ).resolves.toBe(true);
    await expect(
      managesGroupPlanAsNamedExpert(db, booking("org-1"), A),
    ).resolves.toBe(false);
    await expect(
      managesGroupPlanAsNamedExpert(db, { webinar: null, class: null }, HOST),
    ).resolves.toBe(false);
    expect(count).not.toHaveBeenCalled();
  });
});
