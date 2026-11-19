/**
 * @jest-environment node
 */

/**
 * #1675 / #1586 P1-J07/J08 / #1527 W2 — one rendering pin per role page. The
 * consultant's REQUESTED page offers Approve/Decline in the needs-you slot,
 * never says "awaiting payment" on a session row, and draws no progress bar;
 * the consultee's AWAITING_PAYMENT page offers "Pay ₹X" with a countdown.
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: currentDetail,
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
  useMutation: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({
    data: {
      user: { id: viewerId, name: "Viewer", organizationMemberships: [] },
    },
  }),
}));
jest.mock("../../hooks/useSessionFeedback", () => ({
  useSessionFeedback: () => ({
    ratings: {},
    rateable: new Set<string>(),
    isError: false,
    retry: jest.fn(),
  }),
}));
jest.mock("../../components/dashboard/breadcrumb-override", () => ({
  useSetBreadcrumbLabel: () => undefined,
}));
jest.mock("../../components/support/AppointmentSupportStatusCard", () => ({
  AppointmentSupportStatusCard: () => null,
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
// The resource cards read their own APIs; this suite pins the booking states.
jest.mock("../../components/appointments/detail/ResourceSnapshot", () => ({
  ResourceSnapshot: () => null,
}));

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
import type { AppointmentActionAdapter } from "@/lib/appointments/adapter";
import type { TAppointmentDetail } from "@/lib/data/appointment-detail";

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
let currentDetail: TAppointmentDetail;
let viewerId = "u-ethan";

const user = (id: string, name: string) => ({ id, name, image: null });

/** A six-session REQUEST-mode subscription, Rachel → Ethan. */
function subscriptionDetail(over: {
  status: string;
  payment?: TAppointmentDetail["appointment"]["payment"];
  /** Sessions placed so far; six held rows when omitted. */
  sessions?: number;
}): TAppointmentDetail {
  const occurrences = Array.from({ length: over.sessions ?? 6 }, (_, i) => ({
    id: `occ-${i}`,
    appointmentId: "appt-1",
    startsAt: new Date(NOW + (4 + i) * DAY),
    endsAt: new Date(NOW + (4 + i) * DAY + 3_600_000),
    isTentative: true,
    completionStatus: "SCHEDULED",
    deletedAt: null,
    meeting: null,
  }));
  return {
    appointment: {
      id: "appt-1",
      appointmentType: "SUBSCRIPTION",
      organizationId: null,
      organization: null,
      deletedAt: null,
      consultation: null,
      webinar: null,
      class: null,
      trial: null,
      subscription: {
        id: "sub-1",
        status: over.status,
        requestedAt: new Date(NOW - DAY),
        bookingSource: "REQUEST_SUBMITTED",
        pendingPaymentUrl:
          over.status === "APPROVED_PENDING_PAYMENT"
            ? "https://rzp.io/l/x"
            : null,
        subscriptionPlan: {
          id: "plan-1",
          title: "Comprehensive Subscription",
          price: 600_000,
          priceCurrency: "INR",
          totalSessions: 6,
          consultantProfile: {
            id: "cp-1",
            userId: "u-ethan",
            user: user("u-ethan", "Ethan"),
          },
        },
        requestedBy: {
          id: "ce-1",
          userId: "u-rachel",
          user: user("u-rachel", "Rachel Anderson"),
        },
      },
      payment: over.payment ?? [],
      rescheduleRequests: [],
      occurrences,
      participants: [],
      statusHistory: [],
    },
  } as unknown as TAppointmentDetail;
}

const adapter = (
  role: "consultee" | "consultant",
): AppointmentActionAdapter => ({
  role,
  detailHref: () => null,
  primaryAction: () => ({ kind: "view", label: "View" }),
  overflowItems: () => [
    {
      key: "cancel",
      label: "Cancel booking",
      destructive: true,
      onClick: () => undefined,
    },
  ],
  renderDialogs: () => null,
});

function render(role: "consultee" | "consultant") {
  return renderToStaticMarkup(
    <AppointmentDetailClient
      appointmentId="appt-1"
      role={role}
      adapter={adapter(role)}
      backHref="/back"
      resourceHrefs={{
        documents: "/back/appt-1/documents",
        recordings: "/back/appt-1/recordings",
      }}
      supportRequestsBase="/support/requests"
      consultantId="cp-1"
    />,
  );
}

describe("consultant · REQUESTED subscription", () => {
  it("Approve/Decline own the slot; no money word on a session row; no progress bar; no Cancel", () => {
    viewerId = "u-ethan";
    currentDetail = subscriptionDetail({ status: "PENDING" });
    const html = render("consultant");
    expect(html).toContain("Requested");
    expect(html).toContain("Rachel Anderson is waiting for your answer.");
    expect(html).toContain(">Approve<");
    expect(html).toContain("Decline…");
    // A PENDING subscription holds for 30 d (expire-stale-requests.ts).
    expect(html).toMatch(/Held · 2\dd/);
    expect(html).toContain("Sessions · 6 held");
    expect(html).toContain(
      "Not due yet — Rachel Anderson is asked to pay after you approve.",
    );
    expect(html.toLowerCase()).not.toContain("awaiting payment");
    expect(html).not.toContain("No payment is attached");
    expect(html).not.toContain("Program progress");
    expect(html).not.toContain("Cancel booking");
  });
});

describe("consultee · AWAITING_PAYMENT subscription", () => {
  it("Pay ₹X with the GST split, the deadline and a countdown", () => {
    viewerId = "u-rachel";
    currentDetail = subscriptionDetail({
      status: "APPROVED_PENDING_PAYMENT",
      payment: [
        {
          id: "pay-1",
          userId: "u-rachel",
          amount: 708_000,
          taxAmount: 108_000,
          currency: "INR",
          paymentStatus: "PENDING",
          paymentMethod: "CARD",
          paymentGateway: "RAZORPAY",
          receiptUrl: null,
          createdAt: new Date(NOW - 3_600_000),
          expiresAt: new Date(NOW + 22 * 3_600_000),
          organizationId: null,
          consumerInvoice: null,
          legs: [],
          refunds: [],
          disputes: [],
          childPayments: [],
        },
      ] as unknown as TAppointmentDetail["appointment"]["payment"],
    });
    const html = render("consultee");
    expect(html).toContain("Awaiting payment");
    expect(html).toContain("Pay ₹7,080.00 (₹6,000.00 + 18% GST) by ");
    expect(html).toContain("to keep your 6 held slots.");
    expect(html).toContain("Pay ₹7,080.00");
    // The countdown is the hold's clock, labelled as the hold.
    expect(html).toMatch(/Slot held 21h 5\dm/);
    expect(html).not.toMatch(/\dm left/);
    expect(html).toContain("Held · link sent");
    expect(html).toContain("₹7,080.00 due · Razorpay · link valid until ");
    // Nothing has been charged yet, so the money door names the booking.
    expect(html).toContain("Problem with this booking");
    expect(html).not.toContain("Program progress");
    expect(html).not.toContain("Cancel booking");
    expect(html).toContain("Withdraw request");
    // The pay verb also rides the mobile sticky bar; the withdrawal sits in
    // the Manage booking row at the foot of the page, not in the header.
    expect(html.split("Pay ₹7,080.00").length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('aria-label="Manage booking"');
    expect(html.indexOf('aria-label="Manage booking"')).toBeLessThan(
      html.indexOf("Withdraw request"),
    );
    expect(html).not.toContain("More actions");
  });
});

describe("consultee · REQUESTED subscription (#1675 owner decision 2026-09-20)", () => {
  it("says the wait in the reason line, draws no action banner, and puts Withdraw after Get help", () => {
    viewerId = "u-rachel";
    currentDetail = subscriptionDetail({ status: "PENDING" });
    const html = render("consultee");
    // A wait is not an action: the badge's reason line says it, the banner stays away.
    expect(html).toContain("Waiting for Ethan to answer (within 48 hours).");
    expect(html).not.toContain('aria-label="Needs you"');
    // Nothing was ever held or completed, so the profile-review nudge does
    // not appear before there is anything to review.
    expect(html).not.toContain("Reviewed this expert");
    // Demoted: the destructive control renders after "Get help", not
    // leading the action bar the way an actionable Pay/Approve would.
    expect(html.indexOf("Get help")).toBeLessThan(
      html.indexOf("Withdraw request"),
    );
  });
});

describe("consultee · COMPLETED subscription", () => {
  it("shows the review-this-expert nudge once the booking is done", () => {
    viewerId = "u-rachel";
    currentDetail = subscriptionDetail({ status: "COMPLETED" });
    const html = render("consultee");
    expect(html).toContain("Reviewed this expert");
  });
});

function confirmedOneOfFour(): TAppointmentDetail {
  const paid = subscriptionDetail({
    status: "APPROVED",
    payment: [
      {
        id: "pay-1",
        userId: "u-rachel",
        amount: 708_000,
        taxAmount: 108_000,
        currency: "INR",
        paymentStatus: "SUCCEEDED",
        paymentMethod: "CARD",
        paymentGateway: "RAZORPAY",
        receiptUrl: null,
        createdAt: new Date(NOW - 3_600_000),
        expiresAt: null,
        organizationId: null,
        consumerInvoice: null,
        legs: [],
        refunds: [],
        disputes: [],
        childPayments: [],
      },
    ] as unknown as TAppointmentDetail["appointment"]["payment"],
  });
  const sub = paid.appointment.subscription as unknown as Record<
    string,
    unknown
  >;
  sub.sessionsTotal = 4;
  sub.sessionsRefunded = 0;
  sub.schedulingPeriodStartsAt = new Date(NOW);
  sub.schedulingTimezone = "UTC";
  (sub.subscriptionPlan as Record<string, unknown>).totalSessions = 4;
  (sub.subscriptionPlan as Record<string, unknown>).sessionsPerWeek = 2;
  (sub.subscriptionPlan as Record<string, unknown>).durationInMonths = 1;
  paid.appointment.occurrences = [
    { ...paid.appointment.occurrences[0], isTentative: false },
  ];
  return paid;
}

describe("consultee · CONFIRMED subscription, one of four allocated (#1766)", () => {
  it("shows the entitlement count once in the header and no second bar", () => {
    viewerId = "u-rachel";
    currentDetail = confirmedOneOfFour();

    const html = render("consultee");

    expect(html).not.toContain("0 of 1");
    expect(html.split("1 of 4 sessions scheduled")).toHaveLength(2);
    expect(html).not.toContain("Program progress");
  });
});

describe("the next-session card at 390 px", () => {
  it("gives the time column a base width, so the countdown and Join wrap below it instead of squeezing it", () => {
    viewerId = "u-rachel";
    currentDetail = confirmedOneOfFour();
    const html = render("consultee");
    const card = html.match(
      /<div class="mt-5 flex flex-wrap items-center gap-4 rounded-xl[^"]*">.*?<div class="([^"]*)"><p class="text-xs font-medium text-muted-foreground">/,
    );
    expect(card?.[1]).toContain("basis-44");
  });
});

describe("consultant · paid subscription with no session scheduled yet", () => {
  it("counts down the time to schedule, never a held slot", () => {
    viewerId = "u-ethan";
    currentDetail = subscriptionDetail({
      status: "PENDING",
      sessions: 0,
      payment: [
        {
          id: "pay-1",
          paymentStatus: "SUCCEEDED",
          amount: 708_000,
          taxAmount: 108_000,
          currency: "INR",
          paymentMethod: "RAZORPAY",
          paymentGateway: "RAZORPAY",
          receiptUrl: null,
          createdAt: new Date(NOW - 3_600_000),
          capturedAt: new Date(NOW - 3_600_000),
          expiresAt: null,
          organizationId: null,
          consumerInvoice: null,
          legs: [],
          refunds: [],
          disputes: [],
          childPayments: [],
        },
      ] as unknown as TAppointmentDetail["appointment"]["payment"],
    });
    const html = render("consultant").replace(/<!-- -->/g, "");
    expect(html).toMatch(/\d+h \d+m to schedule/);
    expect(html).not.toContain("Slot held");
  });
});

/** A scheduled webinar Ethan hosts, with nobody registered. */
function hostedWebinarDetail(): TAppointmentDetail {
  const base = subscriptionDetail({ status: "PENDING", sessions: 1 });
  return {
    appointment: {
      ...base.appointment,
      appointmentType: "WEBINAR",
      subscription: null,
      webinar: {
        id: "web-1",
        status: "SCHEDULED",
        webinarPlan: {
          id: "wp-1",
          title: "Expert Workshop Webinar",
          price: 0,
          priceCurrency: "INR",
          consultantProfileId: "cp-1",
          consultantProfile: {
            id: "cp-1",
            userId: "u-ethan",
            user: user("u-ethan", "Ethan"),
          },
          collaborators: [],
        },
      },
      occurrences: base.appointment.occurrences.map((o) => ({
        ...o,
        isTentative: false,
      })),
    },
  } as unknown as TAppointmentDetail;
}

/** The page header's text, tags stripped. */
function headerText(html: string) {
  const header = /<header\b[^>]*>([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";
  return header
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("consultant · hosted webinar header", () => {
  it("never reads 'with Registered attendees'; a 1:1 keeps the learner's name", () => {
    viewerId = "u-ethan";
    currentDetail = hostedWebinarDetail();
    const webinar = headerText(render("consultant"));
    expect(webinar).toContain("Expert Workshop Webinar");
    expect(webinar).not.toContain("Registered attendees");
    expect(webinar).not.toMatch(/\bwith\b/);

    currentDetail = subscriptionDetail({ status: "PENDING" });
    expect(headerText(render("consultant"))).toMatch(
      /\bwith Rachel Anderson\b/,
    );
  });
});
