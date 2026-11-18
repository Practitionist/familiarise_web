/**
 * @jest-environment jsdom
 */

/**
 * A money tab whose read fails says so; it never shows an empty queue, a
 * stale page or a silent export. A filter change drops the old page instead
 * of keeping its rows, total and row actions on screen.
 */

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockCapability = {
  tree: "admin",
  basePath: "/dashboard/admin",
  role: "ADMIN",
  can: () => true,
};
jest.mock(
  "../../components/dashboard/backoffice/BackofficeCapabilityProvider",
  () => ({ useBackofficeCapability: () => mockCapability }),
);
const mockToast = jest.fn();
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: jest.fn() }),
}));

import { ApprovalsTab } from "../../components/dashboard/backoffice/money/ApprovalsTab";
import { AuditTab } from "../../components/dashboard/backoffice/money/AuditTab";
import { IncidentsTab } from "../../components/dashboard/backoffice/money/IncidentsTab";
import { SupportSpendTab } from "../../components/dashboard/backoffice/money/SupportSpendTab";
import AdminTDSPage, {
  collectConsultantPages,
} from "../../app/dashboard/(backoffice)/[tree]/tds/TdsPageClient";
import { keepPreviousPageOnly } from "../../components/dashboard/shared/paged-list-filters";
import type { SupportSpendReport } from "../../lib/backoffice/support-spend-types";

const failing = () =>
  jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) });

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

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  mockToast.mockReset();
});

it("Approvals says a failed load failed, not that nothing waits", async () => {
  global.fetch = failing();
  renderWithQuery(<ApprovalsTab viewerId="admin-1" />);
  expect(await screen.findByText("Approvals could not load.")).toBeTruthy();
  expect(screen.queryByText("Nothing here.")).toBeNull();
});

it("Audit says a failed load failed, not that nothing matches", async () => {
  global.fetch = failing();
  renderWithQuery(
    <AuditTab
      initial={{
        rows: [],
        total: 0,
        page: 1,
        pageSize: 50,
        fetchedAt: new Date().toISOString(),
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText("Action"), {
    target: { value: "refund.issue" },
  });
  expect(await screen.findByText("The audit log could not load.")).toBeTruthy();
  expect(screen.queryByText("No actions match these filters.")).toBeNull();
});

it("Incidents says a failed load failed, not that nothing happened", async () => {
  global.fetch = failing();
  renderWithQuery(<IncidentsTab canDeclare={false} />);
  expect(await screen.findByText("Incidents could not load.")).toBeTruthy();
  expect(screen.queryByText("No incident has been declared.")).toBeNull();
});

it("Support spend shows an error for a failed page, not page 1's operators", async () => {
  const initial: SupportSpendReport = {
    operators: [],
    total: 25,
    page: 1,
    pageSize: 10,
    windows: {
      istDayStart: "2026-11-16T18:30:00.000Z",
      rolling24hStart: "2026-11-16T04:00:00.000Z",
      rolling30dStart: "2026-10-18T04:00:00.000Z",
    },
    caps: { perPaymentPaise: 500_000, rolling24hPaise: 5_000_000 },
    fetchedAt: new Date().toISOString(),
  };
  global.fetch = failing();
  renderWithQuery(<SupportSpendTab initial={initial} />);
  expect(screen.getByText("No operators to show.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  expect(
    await screen.findByText("This page of support spend could not load."),
  ).toBeTruthy();
  expect(screen.queryByText("No operators to show.")).toBeNull();
});

describe("TDS export", () => {
  it("reads every page by the page size the server answered, and stops at an empty page", async () => {
    const pages = [
      { consultants: [{ id: 1 }, { id: 2 }], total: 9, pageSize: 2 },
      { consultants: [{ id: 3 }], total: 9, pageSize: 2 },
      { consultants: [], total: 9, pageSize: 2 },
    ];
    const read = jest.fn(async (page: number) => pages[page - 1]);
    const rows = await collectConsultantPages(read);
    expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("tells the operator when an export page fails", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("pageSize=100"))
        return { ok: false, json: async () => ({}) };
      if (url.includes("view=consultants")) {
        return {
          ok: true,
          json: async () => ({
            financialYear: "2026-27",
            consultants: [],
            total: 3,
            deducteeCount: 3,
            page: 1,
            pageSize: 25,
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ financialYear: "2026-27", quarters: [] }),
      };
    }) as unknown as typeof fetch;
    renderWithQuery(<AdminTDSPage />);
    const button = await screen.findByRole("button", { name: /Export CSV/ });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive" }),
      ),
    );
  });
});

it("TDS says the quarterly summary failed, never ₹0.00 or All filed", async () => {
  let quartersOk = false;
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("view=consultants"))
      return { ok: false, json: async () => ({}) };
    if (!quartersOk) return { ok: false, json: async () => ({}) };
    return {
      ok: true,
      json: async () => ({ financialYear: "2026-27", quarters: [] }),
    };
  }) as unknown as typeof fetch;
  renderWithQuery(<AdminTDSPage />);
  expect(
    await screen.findByText("Couldn't load the quarterly TDS summary"),
  ).toBeTruthy();
  expect(screen.queryByText("All filed")).toBeNull();
  expect(screen.queryByText("₹0.00")).toBeNull();
  expect(screen.getAllByText("Unavailable")).toHaveLength(4);

  quartersOk = true;
  fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
  expect(await screen.findByText("All filed")).toBeTruthy();
  expect(
    screen.queryByText("Couldn't load the quarterly TDS summary"),
  ).toBeNull();
});

describe("keepPreviousPageOnly", () => {
  const prev = { rows: ["old"] };
  it("keeps the previous rows while only the page changes", () => {
    const keep = keepPreviousPageOnly(["payments", 2, "PENDING"], 1);
    expect(keep(prev, { queryKey: ["payments", 1, "PENDING"] })).toBe(prev);
  });
  it("drops them when a filter changes", () => {
    const keep = keepPreviousPageOnly(["payments", 1, "FAILED"], 1);
    expect(
      keep(prev, { queryKey: ["payments", 1, "PENDING"] }),
    ).toBeUndefined();
    expect(keep(prev, undefined)).toBeUndefined();
  });
});
