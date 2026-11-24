/**
 * @jest-environment node
 */

/**
 * The booking page's session rows offer stars only where they should: a session
 * parked for ops shows none, while a verifying session the reviews rule allows
 * (an in-person session has no outcome) keeps its rating.
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => ({
    data: queryKey[0] === "reviewable-session" ? [] : mockDetail.current,
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
  useMutation: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({
    data: {
      user: { id: "u-patrick", name: "Patrick", organizationMemberships: [] },
    },
  }),
}));
// Both sessions are rateable and already rated 4 stars.
jest.mock("../../hooks/useSessionFeedback", () => ({
  useSessionFeedback: () => ({
    ratings: { "occ-parked": 4, "occ-verifying": 4 },
    rateable: new Set(["occ-parked", "occ-verifying"]),
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
// Every session's extra, as the page supplies it; the real list folds past rows away.
jest.mock("../../components/appointments/detail/SessionSchedule", () => {
  const ReactInMock = jest.requireActual<typeof import("react")>("react");
  return {
    SessionSchedule: (props: {
      occurrences: { occurrenceId: string }[];
      renderSessionExtra?: (s: { occurrenceId: string }) => unknown;
    }) =>
      ReactInMock.createElement(
        "ul",
        null,
        props.occurrences.map((s) =>
          ReactInMock.createElement(
            "li",
            { key: s.occurrenceId, "data-session": s.occurrenceId },
            props.renderSessionExtra?.(s) as never,
          ),
        ),
      ),
  };
});
jest.mock("../../components/reviews/SessionRatingRow", () => {
  const ReactInMock = jest.requireActual<typeof import("react")>("react");
  return {
    SessionRatingRow: (props: { occurrenceId: string }) =>
      ReactInMock.createElement("i", { "data-stars": props.occurrenceId }),
  };
});

const mockDetail: { current: unknown } = { current: null };

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
import type { AppointmentActionAdapter } from "@/lib/appointments/adapter";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

/** A consultation with two past unverified sessions: one parked, one verifying. */
function detail() {
  const session = (id: string, daysAgo: number, extra: object) => ({
    id,
    appointmentId: "appt-1",
    startsAt: new Date(NOW - daysAgo * DAY),
    endsAt: new Date(NOW - daysAgo * DAY + 3_600_000),
    isTentative: false,
    completionStatus: "UNVERIFIED",
    deletedAt: null,
    meeting: null,
    ...extra,
  });
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
        requestedAt: new Date(NOW - 10 * DAY),
        bookingSource: "DIRECT_CHECKOUT",
        pendingPaymentUrl: null,
        consultationPlan: {
          id: "plan-1",
          title: "Career consultation",
          price: 150_000,
          priceCurrency: "INR",
          durationInHours: 1,
          consultantProfile: {
            id: "cp-1",
            userId: "u-hannah",
            user: { id: "u-hannah", name: "Hannah", image: null },
          },
        },
        requestedBy: {
          id: "ce-1",
          userId: "u-patrick",
          user: { id: "u-patrick", name: "Patrick", image: null },
        },
      },
      payment: [],
      rescheduleRequests: [],
      occurrences: [
        session("occ-parked", 3, { outcome: "NOBODY_JOINED", parked: true }),
        session("occ-verifying", 2, { outcome: null, parked: false }),
      ],
      participants: [],
      statusHistory: [],
      parkedSessions: 1,
    },
  };
}

const adapter: AppointmentActionAdapter = {
  role: "consultee",
  detailHref: () => null,
  primaryAction: () => ({ kind: "view", label: "View" }),
  overflowItems: () => [],
  renderDialogs: () => null,
};

it("a parked session shows no stars; a verifying one the reviews rule allows keeps them", () => {
  mockDetail.current = detail();
  const html = renderToStaticMarkup(
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
      consultantId="cp-1"
    />,
  );
  // Both rows reach the schedule, so the difference is the page's gate.
  expect(html).toContain('data-session="occ-parked"');
  expect(html).toContain('data-session="occ-verifying"');
  expect({
    parked: html.includes('data-stars="occ-parked"'),
    verifying: html.includes('data-stars="occ-verifying"'),
  }).toEqual({ parked: false, verifying: true });
});
