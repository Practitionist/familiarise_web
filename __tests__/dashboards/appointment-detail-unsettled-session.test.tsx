/**
 * @jest-environment node
 */

/**
 * A consultation whose only session was voided invites no rating on its page,
 * even where the rating gate says the learner was in the room: the header
 * reads Confirmed with what happened and what is owed, and neither the stars
 * nor the review card show until it is settled. A delivered session keeps both.
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
      user: {
        id: "u-charlotte",
        name: "Charlotte",
        organizationMemberships: [],
      },
    },
  }),
}));
// The server's rating gate: the learner attended the one session.
jest.mock("../../hooks/useSessionFeedback", () => ({
  useSessionFeedback: () => ({
    ratings: {},
    comments: {},
    ratingCauses: {},
    rateable: new Set<string>(["occ-1"]),
    supportOpen: false,
    submitFeedback: jest.fn(),
    isSubmitting: false,
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
jest.mock("../../components/appointments/detail/ResourceSnapshot", () => ({
  ResourceSnapshot: () => null,
}));

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
import type { AppointmentActionAdapter } from "@/lib/appointments/adapter";
import type { TAppointmentDetail } from "@/lib/data/appointment-detail";

const DAY = 24 * 60 * 60 * 1000;
const STARTED = new Date(Date.now() - DAY);
let currentDetail: TAppointmentDetail;

const user = (id: string, name: string) => ({ id, name, image: null });

function consultationDetail(session: {
  completionStatus: string;
  outcome: string;
  voidedAt: Date | null;
}): TAppointmentDetail {
  return {
    appointment: {
      id: "appt-1",
      appointmentType: "CONSULTATION",
      organizationId: null,
      organization: null,
      deletedAt: null,
      subscription: null,
      webinar: null,
      class: null,
      trial: null,
      consultation: {
        id: "c-1",
        status: "APPROVED",
        requestedAt: new Date(Date.now() - 5 * DAY),
        createdAt: new Date(Date.now() - 5 * DAY),
        bookingSource: "DIRECT_CHECKOUT",
        pendingPaymentUrl: null,
        consultationPlan: {
          id: "plan-1",
          title: "Strategy call",
          price: 100_000,
          priceCurrency: "INR",
          durationInHours: 0.5,
          consultantProfile: {
            id: "cp-1",
            userId: "u-hannah",
            user: user("u-hannah", "Hannah"),
          },
        },
        requestedBy: {
          id: "ce-1",
          userId: "u-charlotte",
          user: user("u-charlotte", "Charlotte"),
        },
      },
      payment: [
        {
          id: "pay-1",
          userId: "u-charlotte",
          amount: 100_000,
          taxAmount: 0,
          currency: "INR",
          paymentStatus: "SUCCEEDED",
          paymentMethod: "CARD",
          paymentGateway: "RAZORPAY",
          receiptUrl: null,
          createdAt: new Date(Date.now() - 5 * DAY),
          expiresAt: null,
          organizationId: null,
          consumerInvoice: null,
          legs: [],
          refunds: [],
          disputes: [],
          childPayments: [],
        },
      ],
      rescheduleRequests: [],
      occurrences: [
        {
          id: "occ-1",
          appointmentId: "appt-1",
          ordinal: 1,
          startsAt: STARTED,
          endsAt: new Date(STARTED.getTime() + 30 * 60_000),
          isTentative: false,
          deletedAt: null,
          meeting: null,
          ...session,
        },
      ],
      participants: [],
      statusHistory: [],
    },
  } as unknown as TAppointmentDetail;
}

const adapter: AppointmentActionAdapter = {
  role: "consultee",
  detailHref: () => null,
  primaryAction: () => ({ kind: "view", label: "View" }),
  overflowItems: () => [],
  renderDialogs: () => null,
};

function render() {
  return renderToStaticMarkup(
    <AppointmentDetailClient
      appointmentId="appt-1"
      role="consultee"
      adapter={adapter}
      backHref="/back"
      resourceHrefs={{
        documents: "/back/appt-1/documents",
        recordings: "/back/appt-1/recordings",
      }}
      supportRequestsBase="/support/requests"
    />,
  );
}

describe("consultee · a consultation whose only session was cut short", () => {
  it("reads Confirmed with the remedy and offers no rating or review", () => {
    currentDetail = consultationDetail({
      completionStatus: "VOIDED",
      outcome: "CUT_SHORT",
      voidedAt: STARTED,
    });
    const html = render();
    expect(html).toContain("Confirmed");
    expect(html).toMatch(
      /This session was cut short\. Hannah owes you a new time by \d{1,2} [A-Z][a-z]{2}, or you are refunded\./,
    );
    // "Completed" stays a step still to come on the timeline, never the badge.
    expect(html).toContain("Next: </span>Completed");
    expect(html).not.toContain("</span>Completed</span>");
    expect(html).not.toContain("Rate this session");
    expect(html).not.toContain("Reviewed this expert");
  });

  it("a delivered session keeps its rating and the review card", () => {
    currentDetail = consultationDetail({
      completionStatus: "COMPLETED",
      outcome: "HELD",
      voidedAt: null,
    });
    const html = render();
    expect(html).toContain("</span>Completed</span>");
    expect(html).toContain("Rate this session");
    expect(html).toContain("Reviewed this expert");
  });
});
