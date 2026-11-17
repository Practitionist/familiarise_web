import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockCapability = { basePath: "/dashboard/admin", role: "ADMIN" };
jest.mock(
  "../../components/dashboard/backoffice/BackofficeCapabilityProvider",
  () => ({ useBackofficeCapability: () => mockCapability }),
);

import { SupportSpendTab } from "../../components/dashboard/backoffice/money/SupportSpendTab";
import { AuditTab } from "../../components/dashboard/backoffice/money/AuditTab";
import type { SupportSpendReport } from "../../lib/backoffice/support-spend-types";

const SINCE = "2026-09-22T02:00:00.000Z";
const audit = (actorUserId: string, action: string) => ({
  actorUserId,
  action,
  since: SINCE,
});

function report(): SupportSpendReport {
  return {
    operators: [
      {
        userId: "staff-1",
        name: "Asha",
        role: "STAFF",
        capped: true,
        refunds: {
          istDayPaise: 50_000,
          rolling24hPaise: 150_000,
          rolling30dPaise: 900_000,
          count30d: 4,
          platformCancel30dPaise: 400_000,
          platformCancelUnsplit30dPaise: 0,
        },
        remainingDailyCapPaise: 4_850_000,
        holds: {
          appliedIstDay: 1,
          applied30d: 3,
          released30d: 1,
          heldPaise30d: 120_000,
          appliedWithoutAmount30d: 2,
        },
        payments: [
          {
            paymentId: "pay-1",
            target: null,
            supportCommittedPaise: 450_000,
            platformCancelPaise: 400_000,
            remainingPerPaymentPaise: 50_000,
            holdsApplied: 0,
          },
        ],
        audit: {
          supportRefunds: audit("staff-1", "support.refund.review"),
          platformCancels: audit("staff-1", "appointment.cancel.platform"),
          holdsApplied: audit("staff-1", "support.hold.apply"),
        },
      },
      {
        userId: "admin-1",
        name: "Chitra",
        role: "ADMIN",
        capped: false,
        refunds: {
          istDayPaise: 0,
          rolling24hPaise: 0,
          rolling30dPaise: 0,
          count30d: 0,
          platformCancel30dPaise: 0,
          platformCancelUnsplit30dPaise: 0,
        },
        remainingDailyCapPaise: null,
        holds: {
          appliedIstDay: 0,
          applied30d: 0,
          released30d: 0,
          heldPaise30d: 0,
          appliedWithoutAmount30d: 0,
        },
        payments: [],
        audit: {
          supportRefunds: audit("admin-1", "support.refund.review"),
          platformCancels: audit("admin-1", "appointment.cancel.platform"),
          holdsApplied: audit("admin-1", "support.hold.apply"),
        },
      },
    ],
    windows: {
      istDayStart: "2026-10-21T18:30:00.000Z",
      rolling24hStart: "2026-10-21T02:00:00.000Z",
      rolling30dStart: SINCE,
    },
    caps: { perPaymentPaise: 500_000, rolling24hPaise: 5_000_000 },
    total: 2,
    page: 1,
    pageSize: 10,
    fetchedAt: new Date().toISOString(),
  };
}

const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => report(),
  });
});
afterEach(() => {
  global.fetch = originalFetch;
});

function renderWithQuery(ui: React.ReactElement) {
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

describe("SupportSpendTab", () => {
  it("labels the IST day and the enforced rolling 24 hours apart, with the limit left", () => {
    renderWithQuery(<SupportSpendTab initial={report()} />);
    expect(
      screen.getAllByText("Refunds today (IST calendar day)")[0],
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Refunds, last 24 hours (limit basis)")[0],
    ).toBeInTheDocument();
    expect(screen.getByText("₹48,500.00")).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "₹50,000.00 per rolling 24 hours, as the refund doors enforce it.",
      ),
    ).toHaveLength(2);
    expect(screen.getByText("₹9,000.00")).toBeInTheDocument();
  });

  it("shows platform cancels as counted toward the per-payment limit", () => {
    renderWithQuery(<SupportSpendTab initial={report()} />);
    expect(
      screen.getAllByText(
        /the daily limit and the ₹5,000\.00 per-payment limit/,
      )[0],
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Platform cancels by this operator")[0],
    ).toBeInTheDocument();
  });

  it("shows holds with the count-only note for older rows", () => {
    renderWithQuery(<SupportSpendTab initial={report()} />);
    expect(screen.getByText("3 applied, 1 released")).toBeInTheDocument();
    expect(
      screen.getByText(
        "2 older holds recorded without an amount (count only).",
      ),
    ).toBeInTheDocument();
  });

  it("marks an admin operator as uncapped", () => {
    renderWithQuery(<SupportSpendTab initial={report()} />);
    expect(screen.getByText("No staff limits")).toBeInTheDocument();
    expect(screen.getAllByText("No staff limit")[0]).toBeInTheDocument();
  });

  it("links each figure to the filtered audit log and each payment to its page", () => {
    renderWithQuery(<SupportSpendTab initial={report()} />);
    const refunds = screen.getAllByRole("link", {
      name: "Support refunds in the audit log",
    })[0];
    const href = new URL(refunds.getAttribute("href") ?? "", "https://x.test");
    expect(href.pathname).toBe("/dashboard/admin/money/audit");
    expect(Object.fromEntries(href.searchParams)).toEqual({
      actorUserId: "staff-1",
      action: "support.refund.review",
      since: SINCE,
    });
    expect(
      screen.getAllByRole("link", { name: "Open payment" })[0],
    ).toHaveAttribute("href", "/dashboard/admin/payments/pay-1");
  });

  it("tells a staff viewer the figures are their own", () => {
    mockCapability.role = "STAFF";
    renderWithQuery(<SupportSpendTab initial={report()} />);
    expect(
      screen.getByText("Your refunds and holds against the staff limits."),
    ).toBeInTheDocument();
    mockCapability.role = "ADMIN";
  });
});

describe("AuditTab URL filters", () => {
  const emptyPage = () => ({
    rows: [],
    total: 0,
    page: 1,
    pageSize: 50,
    fetchedAt: new Date().toISOString(),
  });

  it("holds the query and flags Since while the date is partial", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => emptyPage(),
    });
    renderWithQuery(<AuditTab initial={emptyPage()} />);
    const since = screen.getByLabelText(
      "Since (YYYY-MM-DD, IST day start, or ISO time)",
    );
    fireEvent.change(since, { target: { value: "2026-10" } });
    expect(since).toHaveAttribute("aria-invalid", "true");
    expect(since).toHaveAttribute("aria-describedby", "audit-since-hint");
    expect(
      screen.getByText(
        /Enter Since as a date \(YYYY-MM-DD, from the start of that IST day\)/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Finish the Since date to see matching actions.")[0],
    ).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();

    fireEvent.change(since, { target: { value: "2026-10-01" } });
    expect(since).toHaveAttribute("aria-invalid", "false");
    expect(
      screen.queryByText(
        /Enter Since as a date \(YYYY-MM-DD, from the start of that IST day\)/,
      ),
    ).not.toBeInTheDocument();
    await screen.findAllByText("No actions match these filters.");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("since=2026-10-01"),
    );
  });

  it("seeds the inputs from the drill-through filters", () => {
    renderWithQuery(
      <AuditTab
        initial={{
          rows: [],
          total: 0,
          page: 1,
          pageSize: 50,
          fetchedAt: new Date().toISOString(),
        }}
        initialFilters={{
          actorUserId: "staff-1",
          action: "support.hold.apply",
          since: SINCE,
        }}
      />,
    );
    expect(screen.getByLabelText("Action")).toHaveValue("support.hold.apply");
    expect(
      screen.getByLabelText("Since (YYYY-MM-DD, IST day start, or ISO time)"),
    ).toHaveValue(SINCE);
    expect(screen.getByLabelText("Actor user id")).toHaveValue("staff-1");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(
      screen.getAllByText("No actions match these filters.")[0],
    ).toBeInTheDocument();
  });
});
