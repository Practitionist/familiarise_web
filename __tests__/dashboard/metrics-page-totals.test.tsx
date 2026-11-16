/**
 * Metrics renders the platform totals when the API sends them, and a short
 * unavailable note when it sends null, with the support figures still shown.
 */

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import StaffMetricsPage from "../../app/dashboard/(backoffice)/[tree]/metrics/MetricsPageClient";

const totals = {
  monthStartsAt: "2026-03-31T18:30:00.000Z",
  users: { total: 120, newThisMonth: 7 },
  experts: { total: 30, active: 21 },
  learners: { total: 80, active: 64 },
  staff: { total: 4 },
  sessions: { total: 500, completed: 410, upcoming: 60, cancelled: 9 },
  revenue: { totalPaise: 12_345_600, thisMonthPaise: 99_900 },
  refunds: { totalPaise: 0 },
};

const metrics = (platformTotals: typeof totals | null) => ({
  supportMetrics: {
    ticketsResolvedToday: 1,
    ticketsResolvedThisWeek: 2,
    ticketsResolvedThisMonth: 3,
    openTickets: 9,
    avgResponseTimeHours: 0,
  },
  userMetrics: { usersHelpedThisWeek: 2, activeUsers: 5 },
  platformMetrics: { totalAppointments: 500, pendingPayments: 0 },
  platformTotals,
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function renderWith(platformTotals: typeof totals | null) {
  global.fetch = jest.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url === "/api/staff/metrics"
        ? metrics(platformTotals)
        : { openCases: 9, slaBreaches: 0, windowDays: 7 },
  })) as unknown as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <StaffMetricsPage />
    </QueryClientProvider>,
  );
}

it("renders the totals cards", async () => {
  renderWith(totals);
  expect(
    await screen.findByText("Revenue this month (IST)"),
  ).toBeInTheDocument();
  expect(screen.getByText("+7 this month (IST)")).toBeInTheDocument();
  expect(
    screen.queryByText("Platform totals could not be loaded."),
  ).not.toBeInTheDocument();
});

it("shows the unavailable note and keeps the support figures", async () => {
  renderWith(null);
  expect(
    await screen.findByText("Platform totals could not be loaded."),
  ).toBeInTheDocument();
  expect(screen.getByText("SLA Attainment")).toBeInTheDocument();
  expect(
    screen.queryByText("Revenue this month (IST)"),
  ).not.toBeInTheDocument();
});
