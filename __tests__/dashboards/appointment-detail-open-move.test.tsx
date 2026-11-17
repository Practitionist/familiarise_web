/**
 * @jest-environment node
 */

/**
 * A booking being moved, read through the detail page's real query and
 * rendered for each side: the page names who has to answer and by when, and
 * offers only the answers the respond and withdraw routes take from that viewer.
 */

import { projectRow } from "../fixtures/prisma-projection";
import {
  expert,
  later,
  learner,
  payment,
  plan,
  request,
  wrapper,
} from "../fixtures/stored-bookings";

type Row = Record<string, unknown>;
let mockStored: Row;
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findUnique: (args: Row) => Promise.resolve(projectRow(mockStored, args)),
    },
  },
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
let mockDetail: unknown;
jest.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: mockDetail,
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
  useMutation: () => ({ mutate: jest.fn(), isPending: false }),
}));
let mockViewerId = "u-e";
/** False renders the first paint: the client session has not loaded yet. */
let mockSessionLoaded = true;
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({
    data: mockSessionLoaded
      ? {
          user: {
            id: mockViewerId,
            name: "Viewer",
            organizationMemberships: [],
          },
        }
      : null,
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

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
import { readAppointmentDetail } from "@/lib/data/appointment-detail";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";
import { formatInViewerZone } from "@/lib/time/viewer-zone";

const ZONE = "Asia/Kolkata";
const HOUR = 3_600_000;
const original = new Date(Math.ceil(later(6 * HOUR).getTime() / HOUR) * HOUR);
const proposed = new Date(original.getTime() + 24 * HOUR);
const answerBy = new Date(original.getTime() - 15 * 60_000);
const at = (d: Date) => formatInViewerZone(d, ZONE, "EEE d MMM, h:mm a");

/** A paid 1:1 inside 24 hours, released with one proposed hour. */
function stored(by: "CONSULTANT" | "CONSULTEE"): Row {
  const half = (i: number) => ({
    startsAt: new Date(proposed.getTime() + i * 30 * 60_000),
    endsAt: new Date(proposed.getTime() + (i + 1) * 30 * 60_000),
  });
  return wrapper({
    appointmentType: "CONSULTATION",
    consultationId: "c-1",
    consultation: {
      id: "c-1",
      ...request("PENDING"),
      consultationPlanId: "plan-1",
      consultationPlan: plan,
    },
    occurrences: [
      {
        id: "occ-1",
        appointmentId: "appt-1",
        ordinal: 1,
        startsAt: original,
        endsAt: new Date(original.getTime() + HOUR),
        isTentative: true,
        completionStatus: "RESCHEDULED",
        outcome: null,
        deletedAt: null,
        meeting: null,
      },
    ],
    payment: [
      {
        ...payment("paid"),
        taxAmount: 0,
        paymentGateway: "RAZORPAY",
        receiptUrl: null,
        capturedAt: later(-HOUR),
        consumerInvoice: null,
        disputes: [],
        legs: [],
        childPayments: [],
      },
    ],
    organization: null,
    statusHistory: [],
    rescheduleRequests: [
      {
        id: "rr-1",
        status: "PENDING_REVIEW",
        reason: null,
        expiresAt: answerBy,
        initiatorRole: by,
        initiatedById: by === "CONSULTANT" ? expert.userId : learner.userId,
        proposedTimes: [half(0), half(1)],
      },
    ],
  });
}

async function page(
  by: "CONSULTANT" | "CONSULTEE",
  role: "consultant" | "consultee",
) {
  mockStored = stored(by);
  mockDetail = await readAppointmentDetail("appt-1");
  mockViewerId = role === "consultant" ? expert.userId : learner.userId;
  return renderToStaticMarkup(
    <DisplayZoneProvider zone={ZONE}>
      <AppointmentDetailClient
        appointmentId="appt-1"
        role={role}
        adapter={{
          role,
          detailHref: () => null,
          primaryAction: () => ({ kind: "view", label: "View" }),
          overflowItems: () => [],
          renderDialogs: () => null,
        }}
        backHref="/back"
        resourceHrefs={{ documents: "/d", recordings: "/r" }}
        supportRequestsBase="/support/requests"
        consultantId="cp-1"
      />
    </DisplayZoneProvider>,
  ).replace(/<!-- -->/g, "");
}

const stands = "If nobody answers by then, the original time stands.";

describe.each([
  [
    "CONSULTANT",
    "consultant",
    "You proposed",
    `Charlotte has until ${at(answerBy)} to answer.`,
    ["Withdraw request"],
    ["Accept new times", "Decline…"],
  ],
  [
    "CONSULTANT",
    "consultee",
    "Hannah proposed",
    `Answer by ${at(answerBy)}.`,
    ["Accept new times", "Decline…"],
    ["Withdraw request"],
  ],
  [
    "CONSULTEE",
    "consultant",
    "Charlotte proposed",
    `Answer by ${at(answerBy)}.`,
    ["Accept new times", "Decline…"],
    ["Withdraw request"],
  ],
  [
    "CONSULTEE",
    "consultee",
    "You proposed",
    `Hannah has until ${at(answerBy)} to answer.`,
    ["Withdraw request"],
    ["Accept new times", "Decline…"],
  ],
] as const)(
  "a short-notice move proposed by the %s, seen by the %s",
  (by, role, who, deadline, shown, hidden) => {
    it("names who answers, by when, and what happens otherwise", async () => {
      const html = await page(by, role);
      expect(html).toContain("Being moved");
      expect(html).toContain(`${who} ${at(proposed)}`);
      expect(html).toContain(deadline);
      expect(html).toContain(stands);
      expect(html).not.toContain("restored wherever");
      expect(html).not.toContain("Approve and set times");
      expect(html).not.toContain("Waiting for");
      // The released session keeps its time while the move is open.
      expect(html).not.toContain("No sessions scheduled yet");
      expect(html).toContain(
        "Being moved: this time stands until the new one is accepted.",
      );
      for (const label of shown) expect(html).toContain(`>${label}<`);
      for (const label of hidden) expect(html).not.toContain(`>${label}<`);
    });
  },
);

describe("the first paint, before the session loads", () => {
  afterEach(() => {
    mockSessionLoaded = true;
  });

  it.each([
    ["CONSULTANT", "consultant", "You proposed", "Charlotte has until"],
    ["CONSULTEE", "consultee", "You proposed", "Hannah has until"],
  ] as const)(
    "a move proposed by the %s never tells the %s to answer it",
    async (by, role, who, waits) => {
      mockSessionLoaded = false;
      const html = await page(by, role);
      expect(html).toContain(`${who} ${at(proposed)}`);
      expect(html).toContain(waits);
      expect(html).not.toContain("Answer by");
      expect(html).not.toContain("Needs an answer by");
      expect(html).not.toContain(">Accept new times<");
      expect(html).not.toContain(">Decline…<");
    },
  );
});
