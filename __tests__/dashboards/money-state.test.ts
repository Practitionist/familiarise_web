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
  derivePaymentPresentation,
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
    "REMIND_OR_WITHDRAW",
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
    // #1675 — one session-count story: the money detail prices the plan,
    // the header (not this line) owns the held/plan count.
    expect(c.moneyState.detail).toBe(
      "₹6,000.00 for the plan · 6 sessions · ₹1,000.00 each",
    );
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

  it("consultant AWAITING_PAYMENT: REMIND_OR_WITHDRAW carries the pay order's deadline (#1775)", () => {
    const input = base(TABLE[1][1]);
    const c = deriveBookingPresentation(input, "CONSULTANT", { now: NOW });
    expect(c.nextAction).toEqual({
      kind: "REMIND_OR_WITHDRAW",
      label: "Remind",
      deadline: IN_4D,
    });
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

  it("#1766 — a fresh subscription reads 0 of 12, never a blank", () => {
    const input = base({
      occurrences: [],
      plan: { pricePaise: 14_400, currency: "INR", sessions: 12 },
    });
    const u = deriveBookingPresentation(input, "CONSULTEE", { now: NOW });
    expect(u.sessionProgress).toBe("0 of 12 sessions scheduled");
  });

  it("#1675 — one session-count story: a 6-held / 144-plan subscription", () => {
    const input = base({
      occurrences: Array.from({ length: 6 }, (_, i) =>
        slot(true, new Date(IN_4D.getTime() + i * 3_600_000)),
      ),
      plan: { pricePaise: 14_400, currency: "INR", sessions: 12 },
    });
    const u = deriveBookingPresentation(input, "CONSULTEE", { now: NOW });
    expect(u.moneyState.detail).toBe(
      "₹144.00 for the plan · 12 sessions · ₹12.00 each",
    );
    expect(u.sessionProgress).toBe("6 of 12 sessions scheduled");
  });
});

describe("derivePaymentPresentation — a list row's money is the detail page's", () => {
  const wallet = pay("SUCCEEDED", 500_000, {
    paymentMethod: "WALLET",
    legs: [{ source: "WALLET" }],
  });
  const refund = (amountPaise: number, status: string) => ({
    amountPaise,
    status,
  });
  // money kind · fixture (occurrences are dropped by the row entry point)
  const ROWS: [string, Partial<BookingPresentationInput>][] = [
    ["PAID", { request: req("APPROVED"), payments: paid, holdExpiresAt: null }],
    [
      "PARTIALLY_REFUNDED",
      {
        request: req("APPROVED"),
        payments: paid,
        refunds: [refund(100, "SUCCEEDED")],
      },
    ],
    [
      "REFUNDED",
      {
        request: req("CANCELLED"),
        payments: paid,
        refunds: [refund(708_000, "SUCCEEDED")],
      },
    ],
    [
      "REFUND_PENDING",
      {
        request: req("CANCELLED"),
        payments: paid,
        refunds: [refund(708_000, "PENDING")],
      },
    ],
    [
      "SPONSORED",
      {
        request: req("APPROVED"),
        payments: [wallet],
        sponsorOrgName: "Wipro Limited",
      },
    ],
    [
      "DISPUTED",
      {
        request: req("APPROVED"),
        payments: paid,
        disputes: [{ status: "NEEDS_RESPONSE" }],
      },
    ],
    ["DUE", TABLE[1][1]],
    [
      "FREE",
      {
        request: req("APPROVED"),
        plan: { pricePaise: 0, currency: "INR", sessions: 1 },
      },
    ],
  ];

  it.each(ROWS)("%s", (kind, over) => {
    const { occurrences: _dropped, ...row } = base(over);
    const asRow = derivePaymentPresentation(row, "CONSULTEE", { now: NOW });
    const asDetail = deriveBookingPresentation(
      { ...row, occurrences: [] },
      "CONSULTEE",
      { now: NOW },
    );
    expect(asRow.moneyState.state).toBe(kind);
    expect(asRow.moneyState).toEqual(asDetail.moneyState);
    expect(asRow.nextAction).toEqual(asDetail.nextAction);
    expect(asRow.settled).toBe(asDetail.settled);
  });
});

// #1775 C-5 — a paid plan waits on the consultant: cycle 1 within 48 h of the
// capture, then each next cycle once the last one is done.
describe("ALLOCATE (#1775 C-5)", () => {
  const capturedAt = new Date("2026-09-19T12:00:00Z");
  const paidPending = base({
    occurrences: [],
    payments: [pay("SUCCEEDED", 708_000, { capturedAt })],
    holdExpiresAt: null,
  });

  it("asks the consultant to schedule cycle 1 by capture + 48 h; the consultee waits", () => {
    const consultant = deriveBookingPresentation(paidPending, "CONSULTANT", {
      now: NOW,
    });
    expect(consultant.bookingState.state).toBe("AWAITING_ALLOCATION");
    expect(consultant.nextAction).toEqual({
      kind: "ALLOCATE",
      label: "Schedule cycle 1",
      deadline: new Date("2026-09-21T12:00:00Z"),
    });
    expect(
      deriveBookingPresentation(paidPending, "CONSULTEE", { now: NOW })
        .nextAction.kind,
    ).toBe("NONE");
  });

  it("asks for the next cycle, without a deadline, once the last one is done", () => {
    const presentation = deriveBookingPresentation(
      base({
        request: req("APPROVED"),
        occurrences: [slot(false, PAST)],
        payments: paid,
        holdExpiresAt: null,
        entitlement: { remaining: 4, nextBatch: 4 },
      }),
      "CONSULTANT",
      { now: NOW },
    );
    expect(presentation.nextAction).toEqual({
      kind: "ALLOCATE",
      label: "Schedule the next 4",
    });
  });
});

// #1780 E-5 — a confirmed class seat whose host missed three sessions (or a
// quarter) is offered a full-refund exit; below the threshold it is not.
describe("EXIT_SERIES (#1780 E-5)", () => {
  const classSeat = (misses: number, N: number) =>
    base({
      appointmentType: "CLASS",
      request: { status: "SCHEDULED", kind: "CLASS" },
      occurrences: confirmed,
      payments: paid,
      holdExpiresAt: null,
      series: {
        misses,
        N,
        exitRight: misses >= 3 || 4 * misses >= N,
        undelivered: 6,
      },
    });
  it.each([
    [3, 12, "EXIT_SERIES"],
    [2, 12, "NONE"],
    [2, 8, "EXIT_SERIES"],
  ])("%i misses of %i → %s", (misses, N, kind) => {
    expect(
      deriveBookingPresentation(classSeat(misses, N), "CONSULTEE", { now: NOW })
        .nextAction.kind,
    ).toBe(kind);
  });
});

describe("the refund timeline (#1780)", () => {
  const refund = (status: string, amountPaise: number, refundId: string) => ({
    status,
    amountPaise,
    refundId,
    createdAt: NOW,
  });
  const refundStep = (r: ReturnType<typeof refund>) =>
    deriveBookingPresentation(
      base({ request: req("APPROVED"), payments: paid, refunds: [r] }),
      "CONSULTEE",
      { now: NOW },
    ).timeline.filter((e) => e.kind);

  it.each([
    [refund("PENDING", 708_000, "pending_1"), "refund-requested", /requested/],
    [
      refund("PENDING", 708_000, "rfnd_1"),
      "refund-processing",
      /5–7 working days, UPI 1–3/,
    ],
    [refund("SUCCEEDED", 200_000, "rfnd_2"), "refund-completed", /\(partial\)/],
    [refund("FAILED", 708_000, "rfnd_3"), "refund-failed", /failed/],
  ])("%# emits one %s step", (r, kind, label) => {
    const [step] = refundStep(r);
    expect(step.kind).toBe(kind);
    expect(step.label).toMatch(label);
  });
});
