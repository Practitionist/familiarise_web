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
jest.mock("../../components/support/SupportThreadSheet", () => ({
  SupportThreadSheet: () => null,
}));
jest.mock("../../components/support/AppointmentSupportStatusCard", () => ({
  AppointmentSupportStatusCard: () => null,
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

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
}): TAppointmentDetail {
  const occurrences = Array.from({ length: 6 }, (_, i) => ({
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
    expect(html).toContain(
      "Ethan approved. Pay ₹7,080.00 (₹6,000.00 + 18% GST) by ",
    );
    expect(html).toContain("to keep your 6 held slots.");
    expect(html).toContain("Pay ₹7,080.00");
    expect(html).toMatch(/21h 5\dm left/);
    expect(html).toContain("Held · link sent");
    expect(html).toContain("₹7,080.00 due · Razorpay · link valid until ");
    expect(html).toContain("Problem with this charge");
    expect(html).not.toContain("Program progress");
    expect(html).not.toContain("Cancel booking");
    expect(html).toContain("Withdraw request");
  });
});

describe("consultee · REQUESTED subscription (#1675 owner decision 2026-09-20)", () => {
  it("shows a neutral waiting line, no review prompt, and Withdraw after Get help", () => {
    viewerId = "u-rachel";
    currentDetail = subscriptionDetail({ status: "PENDING" });
    const html = render("consultee");
    expect(html).toContain(
      "Waiting for Ethan to respond — usually within 48 hours.",
    );
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
