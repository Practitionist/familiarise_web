/**
 * @jest-environment node
 */

/**
 * A webinar's appointment page draws the participant list and the Payments
 * card only for a viewer the scoped detail says may see them: the plan's
 * manager sees both, a co-presenter the list alone, support crew neither.
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
jest.mock("../../components/appointments/detail/ResourceSnapshot", () => ({
  ResourceSnapshot: () => null,
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
import type { AppointmentActionAdapter } from "@/lib/appointments/adapter";
import {
  scopeAppointmentDetail,
  type DetailViewer,
  type TAppointmentDetail,
  type TScopedAppointmentDetail,
} from "@/lib/data/appointment-detail";

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const HOST = "u-host";
const PRESENTER = "u-presenter";
const CREW = "u-crew";
const ROSTER_HREF = "/roster/web-1";
let currentDetail: TScopedAppointmentDetail;
let viewerId = HOST;

const user = (id: string, name: string) => ({ id, name, image: null });
const seat = (id: string, name: string) => ({
  userId: id,
  role: "CONSULTEE",
  user: user(id, name),
});

/** A webinar four days out with two seats, one of them paid. */
function webinarDetail(seats: boolean): TAppointmentDetail {
  return {
    appointment: {
      id: "appt-1",
      appointmentType: "WEBINAR",
      organizationId: null,
      organization: null,
      deletedAt: null,
      consultation: null,
      subscription: null,
      class: null,
      trial: null,
      webinarId: "web-1",
      classId: null,
      webinar: {
        id: "web-1",
        status: "SCHEDULED",
        webinarPlan: {
          id: "plan-1",
          title: "Design Systems Live",
          price: 30_000,
          priceCurrency: "INR",
          consultantProfile: {
            id: "cp-host",
            userId: HOST,
            user: user(HOST, "Grace"),
          },
          collaborators: [
            {
              tier: "PRESENTER",
              consultantProfile: {
                id: "cp-presenter",
                userId: PRESENTER,
                user: user(PRESENTER, "David"),
              },
            },
            {
              tier: "CREW",
              consultantProfile: {
                id: "cp-crew",
                userId: CREW,
                user: user(CREW, "Ethan"),
              },
            },
          ],
        },
      },
      payment: seats
        ? [
            {
              id: "p-a",
              userId: "u-a",
              paymentStatus: "SUCCEEDED",
              amount: "30000",
              currency: "INR",
              createdAt: new Date(NOW - DAY),
              expiresAt: null,
              receiptUrl: null,
              consumerInvoice: null,
              refunds: [],
              legs: [],
              disputes: [],
              childPayments: [],
            },
          ]
        : [],
      rescheduleRequests: [],
      occurrences: [
        {
          id: "occ-0",
          appointmentId: "appt-1",
          startsAt: new Date(NOW + 4 * DAY),
          endsAt: new Date(NOW + 4 * DAY + 3_600_000),
          isTentative: false,
          completionStatus: "SCHEDULED",
          deletedAt: null,
          meeting: null,
        },
      ],
      participants: seats
        ? [seat("u-a", "Asha Rao"), seat("u-b", "Ben Ito")]
        : [],
      statusHistory: [],
    },
  } as unknown as TAppointmentDetail;
}

const adapter: AppointmentActionAdapter = {
  role: "consultant",
  detailHref: () => null,
  primaryAction: () => ({ kind: "view", label: "View" }),
  overflowItems: () => [
    { key: "participants", label: "Participants", onClick: () => undefined },
  ],
  renderDialogs: () => null,
};

function pageFor(viewer: DetailViewer, seats = true) {
  viewerId = viewer.userId;
  currentDetail = scopeAppointmentDetail(webinarDetail(seats), viewer);
  return renderToStaticMarkup(
    <AppointmentDetailClient
      appointmentId="appt-1"
      role="consultant"
      adapter={adapter}
      backHref="/back"
      resourceHrefs={{
        documents: "/back/appt-1/documents",
        recordings: "/back/appt-1/recordings",
      }}
      participantsHref={() => ROSTER_HREF}
      supportRequestsBase="/support/requests"
      consultantId="cp-1"
    />,
  );
}

const MANAGER = { userId: HOST, managesGroupPlan: true };
const collaborator = (userId: string) => ({ userId, managesGroupPlan: false });

describe("a webinar's appointment page, by what the viewer may see", () => {
  it("shows the plan's manager the participants, the roster link and the payments", () => {
    const html = pageFor(MANAGER);
    expect(html).toContain("Participants · 2");
    expect(html).toContain("Asha Rao");
    expect(html).toContain(ROSTER_HREF);
    expect(html).toContain("Payments");
    expect(html).toContain("1 of 2 seat");
  });

  it("keeps the manager's empty states for a session nobody has booked", () => {
    const html = pageFor(MANAGER, false);
    expect(html).toContain("No participants on this session yet.");
    expect(html).toContain("No seat has been paid for yet.");
  });

  it("shows a co-presenter the participants and no Payments card", () => {
    const html = pageFor(collaborator(PRESENTER));
    expect(html).toContain("Participants · 2");
    expect(html).toContain("Asha Rao");
    expect(html).not.toContain("Payments");
    expect(html).not.toContain("No seat has been paid for yet.");
  });

  it("shows support crew neither section and no way to the roster", () => {
    const html = pageFor(collaborator(CREW));
    expect(html).not.toContain("Participants");
    expect(html).not.toContain("No participants on this session yet.");
    expect(html).not.toContain(ROSTER_HREF);
    expect(html).not.toContain("Payments");
    expect(html).not.toContain("No seat has been paid for yet.");
  });
});
