import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The booking drawer reads one clock: the list row, "Scheduled At" and the Ops
 * panel's sessions all print India time with a zone label, and UTC on hover.
 */

jest.mock("next/navigation", () => ({
  usePathname: () => "/backoffice/appointments",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
jest.mock("@/lib/navigation/history", () => ({
  replaceUrl: (target: string) => window.history.replaceState(null, "", target),
}));
jest.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => true }));
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/components/dashboard/shared/AppointmentTimeline", () => ({
  AppointmentTimeline: () => null,
}));
jest.mock(
  "@/components/dashboard/backoffice/BackofficeCapabilityProvider",
  () => ({
    useBackofficeCapability: () => ({
      basePath: "/dashboard/staff",
      can: () => false,
    }),
  }),
);
jest.mock(
  "@/components/dashboard/backoffice/money/BookingDocumentsOps",
  () => ({
    BookingDocumentsOps: () => null,
  }),
);
jest.mock("@/components/dashboard/backoffice/money/ClassSeriesDoors", () => ({
  ClassSeriesDoors: () => null,
}));

import { OperatorAppointmentsClient } from "@/components/dashboard/shared/OperatorAppointmentsClient";
import { BookingOpsPanel } from "@/components/dashboard/backoffice/money/BookingOpsPanel";

const STARTS = "2026-11-20T10:00:00.000Z";
const ENDS = "2026-11-20T10:30:00.000Z";
const ID = "8b2f6c1e-1d2a-4f3b-9c4d-5e6f7a8b9c0d";

const appointment = {
  id: ID,
  type: "consultation",
  title: "Career chat",
  consultant: { id: "c1", name: "Asha", email: null, avatar: null },
  consultee: { id: "u1", name: "Ravi", email: null, avatar: null },
  scheduledAt: STARTS,
  endsAt: ENDS,
  duration: 30,
  status: "approved",
  bookingSource: "DIRECT_CHECKOUT",
  free: false,
  removed: false,
  parkedSessions: 0,
  hasIssue: false,
  issueType: null,
  payment: {
    id: "p1",
    amount: 50_000,
    currency: "INR",
    status: "SUCCEEDED",
    gateway: "DODO_PAYMENTS",
    expiresAt: null,
  },
  reschedule: null,
  createdAt: "2026-11-01T10:00:00.000Z",
};

const opsView = {
  appointmentId: ID,
  type: "CONSULTATION",
  classId: null,
  subscriptionId: null,
  sessions: [
    {
      id: "s1",
      ordinal: 1,
      startsAt: STARTS,
      endsAt: ENDS,
      completionStatus: "SCHEDULED",
      outcome: null,
    },
  ],
  payments: [],
  removedSeats: [],
};

beforeEach(() => {
  global.fetch = jest.fn(async (input: string) => ({
    ok: true,
    json: async () =>
      input.endsWith("/ops")
        ? opsView
        : {
            appointments: [appointment],
            counts: { all: 1, issues: 0, scheduled: 1, completed: 0 },
            pagination: {
              total: 1,
              page: 1,
              limit: 20,
              totalPages: 1,
              hasMore: false,
            },
          },
  })) as unknown as typeof fetch;
});

it("prints the row, Scheduled At and every session in IST, with UTC on hover", async () => {
  window.history.replaceState(null, "", `/backoffice/appointments?open=${ID}`);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OperatorAppointmentsClient
        renderOps={(id) => <BookingOpsPanel appointmentId={id} />}
      />
    </QueryClientProvider>,
  );

  const drawer = await screen.findByRole("dialog");
  await within(drawer).findByText(/#1 ·/);
  const starts = within(drawer).getAllByText("20 Nov 2026, 3:30 pm IST");
  // "Scheduled At" and the Ops panel's session start, the same instant.
  expect(starts).toHaveLength(2);
  for (const node of starts) {
    expect(node).toHaveAttribute("title", "20 Nov 2026, 10:00 am UTC");
  }
  // The session's end sits on the same IST day, so it prints its time alone.
  expect(within(drawer).getByText("4:00 pm IST")).toBeInTheDocument();
  expect(drawer.textContent).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  // The payment card names its gateway and status in words, not enum tokens.
  expect(within(drawer).getByText("Dodo Payments")).toBeInTheDocument();
  expect(drawer.textContent).not.toMatch(/DODO_PAYMENTS|SUCCEEDED/);
});
