/**
 * @jest-environment jsdom
 */

/**
 * QA round 1 on the money pages, as an operator reads them: links land on
 * pages that exist, the trace lists a payment once, and no enum reaches the
 * screen as its code.
 */

import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockCapability = {
  tree: "admin",
  basePath: "/dashboard/admin",
  role: "ADMIN",
  can: () => true,
  viewerId: "admin-1",
};
jest.mock(
  "../../components/dashboard/backoffice/BackofficeCapabilityProvider",
  () => ({ useBackofficeCapability: () => mockCapability }),
);
jest.mock(
  "../../components/dashboard/backoffice/money/BookingOpsPanel",
  () => ({ BookingOpsPanel: () => null }),
);
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
let mockSearch = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/dashboard/admin/compliance",
}));

import { SubscriptionsPage } from "../../components/dashboard/shared/SubscriptionsPage";
import { DisputeDetailPage } from "../../components/dashboard/shared/DisputeDetailPage";
import { EntityTraceView } from "../../components/dashboard/backoffice/EntityTraceView";
import { CompliancePageClient } from "../../app/dashboard/(backoffice)/[tree]/compliance/CompliancePageClient";
import { SupportSpendTab } from "../../components/dashboard/backoffice/money/SupportSpendTab";
import PendingPayoutsSection from "../../components/dashboard/backoffice/payouts/sections/PendingPayoutsSection";
import type { EntityTrace } from "../../lib/backoffice/entity-trace-types";

const APPT = "8b2f6c1e-1d2a-4f3b-9c4d-5e6f7a8b9c0d";

// The compliance page's dialogs read the viewport.
Object.defineProperty(window, "matchMedia", {
  value: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
});
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  mockSearch = new URLSearchParams();
});

function serve(body: (url: string) => unknown) {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => ({
    ok: true,
    json: async () => body(String(input)),
  })) as unknown as typeof fetch;
}

function withQuery(ui: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>,
  );
}

it("Subscriptions opens the booking on Appointments, never the missing /bookings page", async () => {
  serve(() => ({
    subscriptions: [
      {
        id: "pay-1",
        paymentId: "pay-1",
        amount: 500_000,
        currency: "INR",
        gateway: "RAZORPAY",
        userName: "Priya Anderson",
        userEmail: "priya@example.test",
        consultantName: "Aarav Anderson",
        startDate: null,
        endDate: null,
        status: "active",
        createdAt: "2026-10-01T00:00:00Z",
        subscriptionId: "sub-1",
        appointmentId: APPT,
      },
    ],
    stats: { activeCount: 1, expiringCount: 0, expiredCount: 0 },
    pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
  }));
  withQuery(<SubscriptionsPage />);
  const ops = await screen.findAllByRole("link", { name: "Ops" });
  for (const link of ops) {
    expect(link).toHaveAttribute(
      "href",
      `/dashboard/admin/appointments?open=${APPT}`,
    );
  }
  expect(document.querySelector('a[href*="/bookings"]')).toBeNull();
});

it("Dispute detail names the gateway, the method and the booking, and goes back to the Money tab", async () => {
  serve(() => ({
    id: "d1",
    disputeId: "disp_1",
    amountPaise: 150_000,
    currency: "INR",
    status: "UNDER_REVIEW",
    reason: "fraudulent",
    paymentGateway: "RAZORPAY",
    paymentId: "pay-1",
    dueBy: null,
    isChargeRefundable: false,
    evidenceSubmittedAt: null,
    assignedToUserId: null,
    assignedTo: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    payment: {
      id: "pay-1",
      paymentIntent: "order_1",
      paymentStatus: "SUCCEEDED",
      amount: 150_000,
      currency: "INR",
      paymentMethod: "CARD",
      createdAt: "2026-11-01T00:00:00Z",
      user: { id: "user-1", name: "Priya Anderson" },
      booking: { id: APPT, type: "CONSULTATION", title: "Career coaching" },
    },
    evidencePack: {
      booking: {
        appointmentId: APPT,
        appointmentType: "CONSULTATION",
        createdAt: "2026-11-01T00:00:00Z",
      },
      occurrences: { total: 0, completedCount: 0, outcomes: [] },
      attendance: { presentCount: 0, recordsFound: false, summary: "None." },
      supportHistory: { ticketCount: 0, openCount: 0, threads: [] },
    },
  }));
  withQuery(<DisputeDetailPage disputeId="d1" />);
  await screen.findAllByText("Career coaching");
  expect(screen.getByText("Razorpay")).toBeTruthy();
  expect(screen.getByText("Card")).toBeTruthy();
  expect(screen.queryByText("RAZORPAY")).toBeNull();
  expect(screen.queryByText(/CONSULTATION \(/)).toBeNull();
  expect(screen.getByRole("link", { name: /Back/ })).toHaveAttribute(
    "href",
    "/dashboard/admin/money/disputes",
  );
});

const paymentTrace = (paymentIds: string[]): EntityTrace => ({
  kind: "payment",
  id: "pay_1",
  paymentIds,
  appointmentId: null,
  userId: "user_1",
  customer: { id: "user_1", name: "Priya Anderson", email: null },
  sentryHref: null,
  rows: [],
  sources: [],
});

it("a payment trace lists the traced payment once", () => {
  render(
    <EntityTraceView
      mode="trace"
      trace={paymentTrace(["pay_1"])}
      seesSystemEvents={false}
    />,
  );
  expect(screen.getAllByText("pay_1")).toHaveLength(1);
  expect(screen.queryByText("Side charges")).toBeNull();
});

it("a payment trace lists its side charges under their own label", () => {
  render(
    <EntityTraceView
      mode="trace"
      trace={paymentTrace(["pay_1", "pay_2"])}
      seesSystemEvents={false}
    />,
  );
  expect(screen.getAllByText("pay_1")).toHaveLength(1);
  expect(screen.getByText("Side charges")).toBeTruthy();
  expect(screen.getByText("pay_2")).toBeTruthy();
});

it("failed emails name the email type in words", async () => {
  mockSearch = new URLSearchParams("tab=emails");
  serve(() => ({
    data: [
      {
        id: "m1",
        recipient: "olivia@example.test",
        subject: "Your session moved",
        emailType: "APPOINTMENT_RESCHEDULED",
        status: "DEAD_LETTER",
        attempts: 3,
        lastError: null,
        createdAt: "2026-11-01T00:00:00Z",
        replayRefusal: null,
      },
    ],
    total: 1,
    page: 1,
    pageSize: 20,
  }));
  withQuery(<CompliancePageClient />);
  expect(
    await screen.findAllByText(
      /olivia@example\.test · Appointment Rescheduled/,
    ),
  ).not.toHaveLength(0);
  expect(screen.queryByText(/APPOINTMENT_RESCHEDULED/)).toBeNull();
});

it("support spend labels the operator's role in words", () => {
  withQuery(
    <SupportSpendTab
      initial={{
        operators: [
          {
            userId: "staff-1",
            name: "Asha",
            role: "STAFF",
            capped: true,
            refunds: {
              istDayPaise: 0,
              rolling24hPaise: 0,
              rolling30dPaise: 0,
              count30d: 0,
              platformCancel30dPaise: 0,
              platformCancelUnsplit30dPaise: 0,
            },
            remainingDailyCapPaise: 0,
            holds: {
              appliedIstDay: 0,
              applied30d: 0,
              released30d: 0,
              heldPaise30d: 0,
              appliedWithoutAmount30d: 0,
            },
            payments: [],
            audit: {
              supportRefunds: {},
              platformCancels: {},
              holdsApplied: {},
            },
          },
        ],
        total: 1,
        page: 1,
        pageSize: 10,
        windows: {
          istDayStart: "2026-11-16T18:30:00.000Z",
          rolling24hStart: "2026-11-16T04:00:00.000Z",
          rolling30dStart: "2026-10-18T04:00:00.000Z",
        },
        caps: { perPaymentPaise: 500_000, rolling24hPaise: 5_000_000 },
        fetchedAt: new Date().toISOString(),
      }}
    />,
  );
  expect(screen.getByText("Staff")).toBeTruthy();
  expect(screen.queryByText("STAFF")).toBeNull();
});

it("pending payouts count one earning in the singular", async () => {
  serve(() => ({
    payouts: [
      {
        id: "cm9pendpayout3344ccdd",
        consultantProfileId: "cp-1",
        consultantUserId: "user-2",
        consultantName: "Aarav Anderson",
        consultantEmail: "aarav@example.test",
        amount: 75_000,
        currency: "INR",
        status: "PENDING",
        method: "BANK_TRANSFER",
        provider: "RAZORPAY",
        kind: null,
        earningsCount: 1,
        approvedAt: null,
        processedAt: null,
        failureReason: null,
        createdAt: "2026-11-01T00:00:00.000Z",
        mustPayByDate: null,
      },
    ],
    pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
  }));
  withQuery(<PendingPayoutsSection />);
  await waitFor(() =>
    expect(screen.getAllByText("1 earning").length).toBeGreaterThan(0),
  );
  expect(screen.queryByText("1 earnings")).toBeNull();
});
