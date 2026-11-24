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
import { exitThresholdFor } from "@/lib/booking/class-series";
import { PLAN_END_REFUND_REASON } from "@/lib/payments/refund-reasons";
import { formatCurrencyAmount } from "@/utils/formatting";

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
    "Cancelled",
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
    "Confirmed",
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
    "Cancelled",
  ],
];

describe("deriveBookingPresentation — the eight booking states", () => {
  it.each(TABLE)(
    "%s",
    (state, over, moneyKind, consultantNext, consulteeNext, row, label) => {
      const input = base(over);
      const asConsultant = deriveBookingPresentation(input, "CONSULTANT", {
        viewerZone: "UTC",
        now: NOW,
      });
      const asConsultee = deriveBookingPresentation(input, "CONSULTEE", {
        viewerZone: "UTC",
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
    const c = deriveBookingPresentation(input, "CONSULTANT", {
      viewerZone: "UTC",
      now: NOW,
    });
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
    const u = deriveBookingPresentation(input, "CONSULTEE", {
      viewerZone: "UTC",
      now: NOW,
    });
    expect(u.moneyState.line).toBe(
      "Not due yet — you are asked to pay after Ethan approves.",
    );
  });

  it("consultant AWAITING_PAYMENT: REMIND_OR_WITHDRAW carries the pay order's deadline (#1775)", () => {
    const input = base(TABLE[1][1]);
    const c = deriveBookingPresentation(input, "CONSULTANT", {
      viewerZone: "UTC",
      now: NOW,
    });
    expect(c.nextAction).toEqual({
      kind: "REMIND_OR_WITHDRAW",
      label: "Remind",
      deadline: IN_4D,
    });
  });

  it("consultee AWAITING_PAYMENT: the PAY action carries the amount and the deadline", () => {
    const input = base({
      ...TABLE[1][1],
      history: [
        {
          fromStatus: "PENDING",
          toStatus: "APPROVED_PENDING_PAYMENT",
          by: "CONSULTANT",
        },
      ],
    });
    const u = deriveBookingPresentation(input, "CONSULTEE", {
      viewerZone: "UTC",
      now: NOW,
    });
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

  it("a trial's timeline starts with one booking entry and never names an approval", () => {
    const trial = (status: string, payments: PaymentInput[]) =>
      base({
        appointmentType: "TRIAL",
        request: { status, kind: "TRIAL", requestedAt: PAST },
        payments,
      });
    const labels = (
      input: BookingPresentationInput,
      viewer: "CONSULTEE" | "CONSULTANT",
    ) =>
      deriveBookingPresentation(input, viewer, {
        viewerZone: "UTC",
        now: NOW,
      }).timeline.map((e) => e.label);
    const awaiting = trial("AWAITING_PAYMENT", [
      pay("PENDING", 10_600, { expiresAt: IN_4D }),
    ]);
    expect(labels(awaiting, "CONSULTEE").slice(0, 2)).toEqual([
      "Booked (you)",
      expect.stringMatching(/^You pay/),
    ]);
    expect(labels(awaiting, "CONSULTANT")[0]).toBe("Booked by Rachel");
    const free = trial("SCHEDULED", []);
    for (const viewer of ["CONSULTEE", "CONSULTANT"] as const) {
      const all = labels({ ...free, occurrences: confirmed }, viewer);
      expect(all.some((l) => /approve|request/i.test(l))).toBe(false);
    }
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
    const u = deriveBookingPresentation(input, "CONSULTEE", {
      viewerZone: "UTC",
      now: NOW,
    });
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
    const u = deriveBookingPresentation(input, "CONSULTEE", {
      viewerZone: "UTC",
      now: NOW,
    });
    expect(u.settled).toBe(false);
    expect(u.bookingState.state).toBe("CONFIRMED");
  });

  it("#1766 — a fresh subscription reads 0 of 12, never a blank", () => {
    const input = base({
      occurrences: [],
      plan: { pricePaise: 14_400, currency: "INR", sessions: 12 },
    });
    const u = deriveBookingPresentation(input, "CONSULTEE", {
      viewerZone: "UTC",
      now: NOW,
    });
    expect(u.sessionProgress).toBe("0 of 12 sessions scheduled");
  });

  it("#1675 — one session-count story: a 6-held / 144-plan subscription", () => {
    const input = base({
      occurrences: Array.from({ length: 6 }, (_, i) =>
        slot(true, new Date(IN_4D.getTime() + i * 3_600_000)),
      ),
      plan: { pricePaise: 14_400, currency: "INR", sessions: 12 },
    });
    const u = deriveBookingPresentation(input, "CONSULTEE", {
      viewerZone: "UTC",
      now: NOW,
    });
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
    const asRow = derivePaymentPresentation(row, "CONSULTEE", {
      viewerZone: "UTC",
      now: NOW,
    });
    const asDetail = deriveBookingPresentation(
      { ...row, occurrences: [] },
      "CONSULTEE",
      { viewerZone: "UTC", now: NOW },
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
      viewerZone: "UTC",
      now: NOW,
    });
    expect(consultant.bookingState.state).toBe("AWAITING_ALLOCATION");
    expect(consultant.nextAction).toEqual({
      kind: "ALLOCATE",
      label: "Schedule cycle 1",
      deadline: new Date("2026-09-21T12:00:00Z"),
    });
    expect(
      deriveBookingPresentation(paidPending, "CONSULTEE", {
        viewerZone: "UTC",
        now: NOW,
      }).nextAction.kind,
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
      { viewerZone: "UTC", now: NOW },
    );
    expect(presentation.nextAction).toEqual({
      kind: "ALLOCATE",
      label: "Schedule the next 4",
    });
  });

  it("words the next-cycle wait for each side", () => {
    const input = base({
      request: req("APPROVED"),
      occurrences: [slot(false, PAST)],
      payments: paid,
      holdExpiresAt: null,
      entitlement: { remaining: 4, nextBatch: 4 },
    });
    const why = (role: "CONSULTANT" | "CONSULTEE") =>
      deriveBookingPresentation(input, role, { viewerZone: "UTC", now: NOW })
        .bookingState.why;
    expect(why("CONSULTANT")).toBe("Week done. Schedule the next 4.");
    expect(why("CONSULTEE")).toBe("Week done. Ethan is placing the next 4.");
  });
});

// #1780 E-5 — a confirmed class seat past the exit threshold is offered a
// full-refund exit; below the threshold it is not.
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
        exitRight: misses >= exitThresholdFor(N),
        undelivered: 6,
      },
    });
  it.each([
    [3, 12, "EXIT_SERIES"],
    [2, 12, "NONE"],
    [14, 100, "NONE"],
    [15, 100, "EXIT_SERIES"],
  ])("%i misses of %i → %s", (misses, N, kind) => {
    expect(
      deriveBookingPresentation(classSeat(misses, N), "CONSULTEE", {
        viewerZone: "UTC",
        now: NOW,
      }).nextAction.kind,
    ).toBe(kind);
  });
});

describe("a class exit waiting for a verdict", () => {
  it("names the session and when it settles, in the viewer's zone, in place of the exit", () => {
    const input = base({
      appointmentType: "CLASS",
      request: { status: "SCHEDULED", kind: "CLASS" },
      occurrences: confirmed,
      payments: paid,
      holdExpiresAt: null,
      series: {
        misses: 3,
        N: 12,
        exitRight: true,
        undelivered: 6,
        exitWait: {
          // 12 Nov 10:00 IST; its verdict at 17:15 IST settles 48 hours later.
          sessionStartsAt: new Date("2026-11-12T04:30:00Z"),
          settlesBy: new Date("2026-11-14T11:45:00Z"),
        },
      },
    });
    const next = deriveBookingPresentation(input, "CONSULTEE", {
      viewerZone: "Asia/Kolkata",
      now: NOW,
    }).nextAction;
    expect(next).toEqual({
      kind: "EXIT_SERIES_WAITS",
      label:
        "We're confirming what happened in your 12 Nov session; you can leave the series once that's settled (by 14 Nov, 5:15 pm IST).",
    });
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
      { viewerZone: "UTC", now: NOW },
    ).timeline.filter((e) => e.kind);

  it("dates processing completion from the refund update rather than its request or bank receipt", () => {
    const r = { ...refund("SUCCEEDED", 708_000, "rfnd_5"), updatedAt: IN_4D };
    const [step] = refundStep(r);
    expect(step.at).toEqual(IN_4D);
    expect(step.label).toContain("bank arrival not confirmed");
  });

  it.each([
    [refund("PENDING", 708_000, "pending_1"), "refund-requested", /requested/],
    [
      refund("PENDING", 708_000, "rfnd_1"),
      "refund-processing",
      /bank arrival varies; receipt is not yet confirmed/,
    ],
    [
      refund("SUCCEEDED", 200_000, "rfnd_2"),
      "refund-completed",
      /Partial refund processed.*bank arrival not confirmed/,
    ],
    [
      refund("SUCCEEDED", 708_000, "rfnd_4"),
      "refund-completed",
      /Refund processed.*bank arrival not confirmed/,
    ],
    [refund("FAILED", 708_000, "rfnd_3"), "refund-failed", /failed/],
  ])("%# emits one %s step", (r, kind, label) => {
    const [step] = refundStep(r);
    expect(step.kind).toBe(kind);
    expect(step.label).toMatch(label);
  });
});

describe("a plan that ended with sessions not held", () => {
  const ended = (
    status: string,
    refunds: BookingPresentationInput["refunds"],
  ) =>
    base({
      request: req(status),
      occurrences: [slot(false, PAST)],
      payments: paid,
      refunds,
      holdExpiresAt: null,
      entitlement: { remaining: 2, nextBatch: 0, notHeld: 2, planEnded: true },
    });
  const whyFor = (input: BookingPresentationInput) =>
    (["CONSULTANT", "CONSULTEE"] as const).map(
      (role) =>
        deriveBookingPresentation(input, role, { viewerZone: "UTC", now: NOW })
          .bookingState,
    );

  it("says so before the plan-end sweep, for both sides", () => {
    for (const state of whyFor(ended("APPROVED", []))) {
      expect(state).toMatchObject({
        state: "COMPLETED",
        why: "Plan ended · 2 sessions were not held.",
      });
    }
  });

  it("adds the settlement's refund once the sweep has paid it", () => {
    const refunds = [
      {
        amountPaise: 177_000,
        status: "SUCCEEDED",
        reason: PLAN_END_REFUND_REASON,
      },
      // An earlier, unrelated refund is not the settlement.
      { amountPaise: 50_000, status: "SUCCEEDED", reason: "operator goodwill" },
    ];
    for (const { why } of whyFor(ended("COMPLETED", refunds))) {
      expect(why).toBe(
        `Plan ended · 2 sessions were not held. ${formatCurrencyAmount(177_000, "INR")} refunded.`,
      );
    }
  });

  it("adds no reason line to a plan that delivered everything", () => {
    const input = base({
      request: req("COMPLETED"),
      occurrences: [slot(false, PAST)],
      payments: paid,
      holdExpiresAt: null,
      entitlement: { remaining: 0, nextBatch: 0, notHeld: 0, planEnded: true },
    });
    expect(whyFor(input)[0].why).toBe("");
  });
});
