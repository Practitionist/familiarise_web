/**
 * @jest-environment node
 */

/**
 * One payment, one sentence: the booking page, the Billing history row and the
 * payment page read the same stored rows through their real queries and must
 * print the same money state. "Nothing was charged" is said only when no
 * gateway order ever existed, "refunded automatically" only when a late capture
 * is refunded, and a pay window that closed never reads "Not due yet".
 */

import { projectRow } from "../fixtures/prisma-projection";
import {
  later,
  learner,
  occurrence,
  plan,
  wrapper,
} from "../fixtures/stored-bookings";
import {
  CP,
  NOW as INBOX_NOW,
  hoursAgo,
  hoursAhead,
  pendingConsultation,
  serve,
} from "../fixtures/requests-inbox";

type Row = Record<string, unknown>;
let mockAppointment: Row;
let mockPayment: Row;
let mockInbox: ReturnType<typeof serve>;
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findUnique: (args: Row) =>
        Promise.resolve(projectRow(mockAppointment, args)),
    },
    payment: {
      findFirst: (args: Row) => Promise.resolve(projectRow(mockPayment, args)),
      findMany: (args: Row) => Promise.resolve([projectRow(mockPayment, args)]),
      count: () => Promise.resolve(1),
    },
    refund: {
      findMany: (args: Row) =>
        Promise.resolve(
          (mockPayment.refunds as Row[]).map((r) => projectRow(r, args)),
        ),
    },
    consumerCreditNote: { findMany: () => Promise.resolve([]) },
    referralCredit: {
      findMany: () => Promise.resolve([]),
      aggregate: () => Promise.resolve({ _sum: {} }),
    },
    referralCreditUsage: { findMany: () => Promise.resolve([]) },
    consultation: {
      findMany: (args: Row) => mockInbox.findMany(args as never),
      count: (args: Row) => mockInbox.count(args as never),
    },
    subscription: {
      findMany: () => Promise.resolve([]),
      count: () => Promise.resolve(0),
    },
    trial: {
      findMany: () => Promise.resolve([]),
      count: () => Promise.resolve(0),
    },
    membership: { findMany: () => Promise.resolve([]) },
  },
}));
jest.mock("@/lib/appointments/report-anomalies", () => ({
  bookingAnomalies: () => [],
  scheduleAnomalyReport: () => undefined,
}));

import { readAppointmentDetail } from "@/lib/data/appointment-detail";
import { readConsulteePayments } from "@/lib/data/consultee-payments";
import { readConsulteePaymentDetail } from "@/lib/data/consultee-payment-detail";
import { readRequestsInbox } from "@/lib/data/requests-inbox";
import {
  presentationNames,
  toPresentationInput,
} from "@/lib/appointments/presentation-input";
import {
  deriveBookingPresentation,
  derivePaymentPresentation,
  type MoneyState,
  type Viewer,
} from "@/lib/dashboard/money-state";
import { moneyLine } from "@/components/dashboard/shared/requests/InboxRow";
import { formatInViewerZone } from "@/lib/time/viewer-zone";

const MIN = 60_000;
const ZONE = "UTC";
const IF_CHARGED = "If you were charged, the money is refunded automatically.";
/** A PENDING order on an open booking: a late capture confirms it while the time is free. */
const stillOpen = (closed: string, who = "your") =>
  `The payment window closed on ${closed}. If ${who} payment still goes through, the booking is confirmed while the time can still be booked; otherwise the money is refunded automatically.`;

interface Stored {
  status: string;
  source: "DIRECT_CHECKOUT" | "REQUEST_SUBMITTED";
  payment: string;
  intent?: string;
  expiresAt?: Date;
  refunded?: boolean;
  history?: { fromStatus: string; toStatus: string }[];
  /** A webinar seat held by the learner, in place of the 1:1. */
  seat?: string;
}

/** The learner's webinar seat, as the event and its roster hold it. */
const webinarSeat = (seat: string) => ({
  appointmentType: "WEBINAR",
  webinarId: "w-1",
  webinar: {
    id: "w-1",
    status: "SCHEDULED",
    webinarPlanId: "plan-1",
    webinarPlan: { ...plan, collaborators: [] },
  },
  participants: [
    {
      userId: "u-l",
      role: "CONSULTEE",
      status: seat,
      deletedAt: null,
      user: learner.user,
    },
  ],
});

/** The one Payment row and the 1:1 it paid for, as the tables hold them. */
function seed(s: Stored) {
  const consultation = {
    id: "c-1",
    status: s.status,
    bookingSource: s.source,
    requestedAt: later(-2 * 60 * MIN),
    createdAt: later(-2 * 60 * MIN),
    pendingPaymentUrl: null,
    requestNotes: null,
    requestedById: "cee-1",
    requestedBy: learner,
    consultationPlanId: "plan-1",
    consultationPlan: plan,
  };
  const refunds = s.refunded
    ? [
        {
          id: "r-1",
          amountPaise: 50_000,
          currency: "INR",
          status: "SUCCEEDED",
          refundId: "rfnd_1",
          reason: null,
          deletedAt: null,
          createdAt: later(-MIN),
          updatedAt: later(-MIN),
        },
      ]
    : [];
  const payment = {
    id: "pay-1",
    userId: "u-l",
    amount: 50_000,
    originalAmount: 50_000,
    taxAmount: 0,
    welcomeDiscountPaise: 0,
    currency: "INR",
    paymentStatus: s.payment,
    paymentMethod: "CARD",
    paymentGateway: "RAZORPAY",
    paymentIntent: s.intent ?? "order_N1",
    receiptUrl: null,
    expiresAt: s.expiresAt ?? later(-30 * MIN),
    createdAt: later(-60 * MIN),
    capturedAt: s.payment === "SUCCEEDED" ? later(-60 * MIN) : null,
    deletedAt: null,
    parentPaymentId: null,
    organizationId: null,
    organization: null,
    gstRegime: "UNREGISTERED",
    discountCode: null,
    consumerInvoice: null,
    legs: [],
    refunds,
    disputes: [],
    childPayments: [],
    creditUsages: [],
  };
  const statusHistory = (s.history ?? []).map((edge) => ({
    ...edge,
    entity: "CONSULTATION",
    reason: null,
    actorUserId: null,
    createdAt: later(-20 * MIN),
  }));
  const shared = {
    ...(s.seat
      ? webinarSeat(s.seat)
      : {
          appointmentType: "CONSULTATION",
          consultationId: "c-1",
          consultation,
        }),
    statusHistory,
    supportCases: [],
  };
  mockAppointment = wrapper({
    ...shared,
    organization: null,
    occurrences: [occurrence(s.payment !== "SUCCEEDED")],
    payment: [payment],
  });
  mockPayment = { ...payment, appointment: wrapper(shared) };
}

type Shown = Pick<MoneyState, "state" | "label" | "line">;
const shown = (m: MoneyState): Shown => ({
  state: m.state,
  label: m.label,
  line: m.line,
});

/** What each learner screen prints about the seeded payment. */
async function screens() {
  const detail = await readAppointmentDetail("appt-1");
  if (!detail) throw new Error("no booking");
  const bookingPage = deriveBookingPresentation(
    toPresentationInput(detail, {
      viewerId: "u-l",
      names: presentationNames(detail, {
        role: "consultee",
        name: "Charlotte",
      }),
      sponsorOrgName: null,
    }),
    "CONSULTEE",
    { viewerZone: ZONE },
  ).moneyState;
  const history = await readConsulteePayments({
    consulteeId: "cee-1",
    userId: "u-l",
    orgScope: { kind: "personal" },
  });
  const historyRow = derivePaymentPresentation(
    history.payments[0].presentation,
    "CONSULTEE",
    { viewerZone: ZONE },
  ).moneyState;
  const paymentPage = await readConsulteePaymentDetail({
    paymentId: "pay-1",
    consulteeId: "cee-1",
    userId: "u-l",
    viewerZone: ZONE,
  });
  if (!paymentPage) throw new Error("no payment");
  return [bookingPage, historyRow, paymentPage.moneyState].map(shown);
}

const day = (d: Date) => formatInViewerZone(d, ZONE, "EEE d MMM");
const dayTime = (d: Date) => formatInViewerZone(d, ZONE, "EEE d MMM HH:mm");
const windowOpen = later(15 * MIN);
const windowClosed = later(-5 * MIN);

const STATES: [string, Stored, Partial<Shown>][] = [
  [
    "pending, pay window open",
    {
      status: "APPROVED_PENDING_PAYMENT",
      source: "REQUEST_SUBMITTED",
      payment: "PENDING",
      expiresAt: windowOpen,
    },
    {
      label: "Due",
      line: `₹500.00 due · Razorpay · link valid until ${dayTime(windowOpen)}`,
    },
  ],
  [
    "pending, pay window passed (a pay-first hold not yet swept)",
    {
      status: "PENDING",
      source: "DIRECT_CHECKOUT",
      payment: "PENDING",
      expiresAt: windowClosed,
    },
    { label: "Not completed", line: stillOpen(day(windowClosed)) },
  ],
  [
    "pending, pay window passed (an approval link not yet swept)",
    {
      status: "APPROVED_PENDING_PAYMENT",
      source: "REQUEST_SUBMITTED",
      payment: "PENDING",
      expiresAt: windowClosed,
    },
    { label: "Not completed", line: stillOpen(day(windowClosed)) },
  ],
  [
    "a held webinar seat, pay window open",
    {
      status: "SCHEDULED",
      source: "DIRECT_CHECKOUT",
      payment: "PENDING",
      expiresAt: windowOpen,
      seat: "HELD",
    },
    {
      label: "Due",
      line: `₹500.00 due · Razorpay · link valid until ${dayTime(windowOpen)}`,
    },
  ],
  [
    "a held webinar seat, pay window passed",
    {
      status: "SCHEDULED",
      source: "DIRECT_CHECKOUT",
      payment: "PENDING",
      expiresAt: windowClosed,
      seat: "HELD",
    },
    {
      label: "Not completed",
      line: stillOpen(day(windowClosed)).replace("the time", "a place"),
    },
  ],
  [
    "pending order on a booking that was cancelled",
    {
      status: "CANCELLED",
      source: "DIRECT_CHECKOUT",
      payment: "PENDING",
      expiresAt: windowClosed,
    },
    {
      label: "Not completed",
      line: `This order was cancelled. ${IF_CHARGED}`,
    },
  ],
  [
    "created, then expired by the sweep",
    {
      status: "EXPIRED",
      source: "DIRECT_CHECKOUT",
      payment: "EXPIRED",
      history: [{ fromStatus: "PENDING", toStatus: "EXPIRED" }],
    },
    {
      label: "Not completed",
      line: `The payment link expired. ${IF_CHARGED}`,
    },
  ],
  [
    "created, then cancelled",
    { status: "CANCELLED", source: "DIRECT_CHECKOUT", payment: "EXPIRED" },
    {
      label: "Not completed",
      line: `This order was cancelled. ${IF_CHARGED}`,
    },
  ],
  [
    "never created (a pre-mint placeholder)",
    {
      status: "CANCELLED",
      source: "DIRECT_CHECKOUT",
      payment: "EXPIRED",
      intent: "premint_9f2c",
    },
    { label: "Not charged", line: "Nothing was charged for this booking." },
  ],
  [
    "failed",
    {
      status: "APPROVED_PENDING_PAYMENT",
      source: "REQUEST_SUBMITTED",
      payment: "FAILED",
    },
    {
      label: "Not completed",
      line: `The payment did not go through. ${IF_CHARGED}`,
    },
  ],
  [
    "succeeded",
    { status: "APPROVED", source: "REQUEST_SUBMITTED", payment: "SUCCEEDED" },
    { state: "PAID", label: "Paid" },
  ],
  [
    "refunded",
    {
      status: "CANCELLED",
      source: "REQUEST_SUBMITTED",
      payment: "SUCCEEDED",
      refunded: true,
    },
    { state: "REFUNDED", label: "Refunded" },
  ],
];

describe("every learner screen says the same thing about one payment", () => {
  it.each(STATES)("%s", async (_name, stored, expected) => {
    seed(stored);
    const [bookingPage, historyRow, paymentPage] = await screens();
    expect(historyRow).toEqual(bookingPage);
    expect(paymentPage).toEqual(bookingPage);
    expect(bookingPage).toMatchObject(expected);
  });

  it.each([1, 2])(
    "a closed window on an open order never promises a refund or reads Not due yet, for the learner or the expert (state %i)",
    async (i) => {
      seed(STATES[i][1]);
      const lines = (await screens()).map((s) => s.line);
      const detail = await readAppointmentDetail("appt-1");
      const expertPage = deriveBookingPresentation(
        toPresentationInput(detail!, {
          viewerId: "u-e",
          names: presentationNames(detail!, { role: "consultant", name: null }),
          sponsorOrgName: null,
        }),
        "CONSULTANT",
        { viewerZone: ZONE },
      ).moneyState.line;
      for (const line of [...lines, expertPage]) {
        expect(line).not.toMatch(
          /Not due yet|Nothing was charged|If (you were|Charlotte was) charged/,
        );
      }
      expect(expertPage).toBe(stillOpen(day(windowClosed), "Charlotte's"));
    },
  );
});

describe("the expert's Requests row and booking page agree on a checkout hold", () => {
  const hold = {
    ...pendingConsultation,
    id: "c-hold",
    bookingSource: "DIRECT_CHECKOUT",
    appointment: {
      ...pendingConsultation.appointment,
      payment: [
        {
          id: "a-c-p0",
          amount: 150_000,
          originalAmount: 150_000,
          taxAmount: 0,
          currency: "INR",
          paymentStatus: "PENDING",
          paymentIntent: "order_hold",
          paymentMethod: "CARD",
          paymentGateway: "RAZORPAY",
          receiptUrl: null,
          expiresAt: hoursAhead(0.25),
          createdAt: hoursAgo(0.1),
          consumerInvoice: null,
          legs: [],
          refunds: [],
          disputes: [],
        },
      ],
    },
  };

  const inboxMoney = async (viewer: Viewer, now: Date) => {
    mockInbox = serve([hold]);
    const { rows } = await readRequestsInbox({
      consultantProfileId: CP,
      type: "consultation",
      sort: "priority",
      page: 1,
      now: INBOX_NOW,
    });
    const row = rows.find((r) => r.id === "c-hold");
    if (!row) throw new Error("hold not listed");
    const { moneyState } = deriveBookingPresentation(row.presentation, viewer, {
      viewerZone: ZONE,
      now,
    });
    return moneyLine(row, moneyState);
  };

  it("an open checkout reads due with its window, never Not due yet", async () => {
    const until = formatInViewerZone(hoursAhead(0.25), ZONE, "EEE d MMM HH:mm");
    expect(await inboxMoney("CONSULTANT", INBOX_NOW)).toBe(
      `₹1,500.00 due · Razorpay · link valid until ${until}`,
    );
  });

  it("a row left open past the window says a late payment can still confirm it", async () => {
    expect(await inboxMoney("CONSULTANT", hoursAhead(1))).toBe(
      `₹1,500.00 · ${stillOpen(formatInViewerZone(hoursAhead(0.25), ZONE, "EEE d MMM"), "Priya Nair's")}`,
    );
  });
});
