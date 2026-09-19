/**
 * @jest-environment node
 */

/**
 * #1675 / #1586 P1-J07/J08 / #1527 W2 — one derivation per booking. Each row
 * of the table is one of the eight booking states as the rows produce it; the
 * pin asserts the state, the money state and the one next action per viewer,
 * plus the schedule-only session-row words.
 */

import {
  deriveBookingPresentation,
  type BookingPresentationInput,
  type PaymentInput,
} from "@/lib/dashboard/money-state";

const NOW = new Date("2026-09-20T09:12:00Z");
const IN_4D = new Date("2026-09-24T09:12:00Z");
const PAST = new Date("2026-09-19T09:12:00Z");

const pay = (
  paymentStatus: string,
  amount: number,
  extra: Partial<PaymentInput> = {},
): PaymentInput => ({
  id: "p1",
  paymentStatus,
  paymentMethod: "CARD",
  paymentGateway: "RAZORPAY",
  receiptUrl: null,
  consumerInvoice: null,
  amount,
  currency: "INR",
  createdAt: PAST,
  ...extra,
});

const slot = (isTentative: boolean, startsAt = IN_4D) => ({
  startsAt,
  endsAt: new Date(startsAt.getTime() + 3_600_000),
  isTentative,
});

const base = (
  over: Partial<BookingPresentationInput>,
): BookingPresentationInput => ({
  appointmentType: "SUBSCRIPTION",
  request: { status: "PENDING", kind: "SUBSCRIPTION", requestedAt: PAST },
  occurrences: [slot(true)],
  payments: [],
  refunds: [],
  disputes: [],
  childPayments: [],
  sponsorOrgName: null,
  holdExpiresAt: IN_4D,
  names: { payer: "Rachel", consultant: "Ethan" },
  ...over,
});

const req = (status: string) => ({ status, kind: "SUBSCRIPTION" });
const paid = [pay("SUCCEEDED", 708_000)];
const confirmed = [slot(false)];

// state · fixture · money · consultant next · consultee next · session row · label
const TABLE: [
  string,
  Partial<BookingPresentationInput>,
  string,
  string,
  string,
  string,
  string,
][] = [
  [
    "REQUESTED",
    {},
    "NOT_DUE",
    "APPROVE_OR_DECLINE",
    "NONE",
    "Held · 4d",
    "Requested",
  ],
  [
    "AWAITING_PAYMENT",
    {
      request: req("APPROVED_PENDING_PAYMENT"),
      payments: [pay("PENDING", 708_000, { expiresAt: IN_4D })],
    },
    "DUE",
    "NONE",
    "PAY",
    "Held · link sent",
    "Awaiting payment",
  ],
  [
    "PAYMENT_LAPSED",
    {
      request: req("EXPIRED"),
      payments: [pay("EXPIRED", 708_000, { expiresAt: PAST })],
      holdExpiresAt: PAST,
    },
    "NOT_DUE",
    "NONE",
    "REQUEST_AGAIN",
    "Released",
    "Payment lapsed",
  ],
  [
    "CONFIRMED",
    {
      request: req("APPROVED"),
      occurrences: confirmed,
      payments: paid,
      holdExpiresAt: null,
    },
    "PAID",
    "NONE",
    "NONE",
    "Scheduled",
    "Confirmed",
  ],
  [
    "AWAITING_ALLOCATION",
    {
      request: req("APPROVED"),
      occurrences: [],
      payments: paid,
      holdExpiresAt: null,
    },
    "PAID",
    "NONE",
    "NONE",
    "",
    "Awaiting schedule",
  ],
  [
    "COMPLETED",
    {
      request: req("COMPLETED"),
      occurrences: [slot(false, PAST)],
      payments: paid,
      holdExpiresAt: null,
    },
    "PAID",
    "NONE",
    "RATE",
    "Completed",
    "Completed",
  ],
  [
    "CANCELLED",
    {
      request: req("CANCELLED"),
      payments: paid,
      refunds: [{ amountPaise: 708_000, status: "PENDING" }],
      holdExpiresAt: null,
    },
    "REFUND_PENDING",
    "NONE",
    "NONE",
    "Released",
    "Cancelled",
  ],
  [
    "DECLINED",
    { request: req("REJECTED"), holdExpiresAt: null },
    "NOT_DUE",
    "NONE",
    "REQUEST_AGAIN",
    "Released",
    "Declined",
  ],
];

describe("deriveBookingPresentation — the eight booking states", () => {
  it.each(TABLE)(
    "%s",
    (state, over, moneyKind, consultantNext, consulteeNext, row, label) => {
      const input = base(over);
      const asConsultant = deriveBookingPresentation(input, "CONSULTANT", {
        now: NOW,
      });
      const asConsultee = deriveBookingPresentation(input, "CONSULTEE", {
        now: NOW,
      });
      expect(asConsultant.bookingState.state).toBe(state);
      expect(asConsultant.bookingState.label).toBe(label);
      expect(asConsultant.moneyState.state).toBe(moneyKind);
      expect(asConsultant.nextAction.kind).toBe(consultantNext);
      expect(asConsultee.nextAction.kind).toBe(consulteeNext);
      const rowLabel = input.occurrences[0]
        ? asConsultant.sessionRowLabel(input.occurrences[0])
        : "";
      expect(rowLabel).toBe(row);
      // The session row never carries a money word; the badge is one or two words.
      expect(rowLabel.toLowerCase()).not.toMatch(/pay|paid|₹/);
      expect(label.split(" ").length).toBeLessThanOrEqual(2);
    },
  );
});

describe("deriveBookingPresentation — the money line and the timeline", () => {
  it("consultant REQUESTED: not-due line names the payer; consultee: 'you'", () => {
    const input = base({
      plan: { pricePaise: 600_000, currency: "INR", sessions: 6 },
    });
    const c = deriveBookingPresentation(input, "CONSULTANT", { now: NOW });
    expect(c.moneyState.line).toBe(
      "Not due yet — Rachel is asked to pay after you approve.",
    );
    expect(c.moneyState.detail).toContain("6 × ");
    expect(c.timeline.map((e) => `${e.done ? "●" : "○"} ${e.label}`)).toEqual([
      "● Requested by Rachel",
      "○ You approve",
      "○ Rachel pays (link valid 24 h)",
      "○ Sessions confirmed",
      "○ Completed",
    ]);
    const u = deriveBookingPresentation(input, "CONSULTEE", { now: NOW });
    expect(u.moneyState.line).toBe(
      "Not due yet — you are asked to pay after Ethan approves.",
    );
  });

  it("consultee AWAITING_PAYMENT: the PAY action carries the amount and the deadline", () => {
    const input = base(TABLE[1][1]);
    const u = deriveBookingPresentation(input, "CONSULTEE", { now: NOW });
    expect(u.nextAction).toEqual({
      kind: "PAY",
      label: "Pay ₹7,080.00",
      deadline: IN_4D,
    });
    expect(u.moneyState.line).toMatch(
      /^₹7,080\.00 due · Razorpay · link valid until /,
    );
    expect(u.timeline.slice(0, 3).map((e) => e.label)).toEqual([
      "Requested (you)",
      "Approved (Ethan)",
      expect.stringMatching(/^You pay/),
    ]);
  });

  it("sponsored shows the organisation and no amount; a co-pay appends", () => {
    const input = base({
      request: { status: "APPROVED", kind: "CONSULTATION" },
      appointmentType: "CONSULTATION",
      occurrences: [slot(false)],
      payments: [
        pay("SUCCEEDED", 500_000, {
          paymentMethod: "WALLET",
          legs: [{ source: "WALLET" }],
        }),
      ],
      childPayments: [pay("SUCCEEDED", 50_000, { id: "c1" })],
      sponsorOrgName: "Wipro Limited",
      holdExpiresAt: null,
    });
    const u = deriveBookingPresentation(input, "CONSULTEE", { now: NOW });
    expect(u.moneyState.state).toBe("SPONSORED");
    expect(u.moneyState.line).toBe(
      "Sponsored by Wipro Limited + ₹500.00 co-pay",
    );
    expect(u.moneyState.line).not.toContain("5,000");
  });

  it("#1752 — money in but rows still tentative is not settled", () => {
    const input = base({
      request: { status: "APPROVED", kind: "CONSULTATION" },
      payments: [pay("SUCCEEDED", 500_000)],
    });
    const u = deriveBookingPresentation(input, "CONSULTEE", { now: NOW });
    expect(u.settled).toBe(false);
    expect(u.bookingState.state).toBe("CONFIRMED");
  });
});
