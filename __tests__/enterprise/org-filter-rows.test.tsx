import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockReplace = jest.fn();
let mockSearch = "";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  usePathname: () => "/dashboard/organization/org-1/appointments",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

// React 18.3 has no `use`; the audit page unwraps its params promise with it.
jest.mock("react", () => ({
  ...jest.requireActual("react"),
  use: () => ({ orgId: "org-1" }),
}));

jest.mock("@/app/dashboard/organization/[orgId]/useOrgRole", () => ({
  useOrgRole: () => ({ role: "OWNER", can: () => true }),
  useRequireOrgAccess: () => ({ allowed: true, isLoading: false }),
}));

import AuditLogPage from "@/app/dashboard/organization/[orgId]/audit/page";
import { MemberSpendPanel } from "@/app/dashboard/organization/[orgId]/reimbursements/MemberSpendPanel";
import { AppointmentsPageClient } from "@/app/dashboard/organization/[orgId]/appointments/AppointmentsPageClient";

const fetchMock = jest.fn();

beforeEach(() => {
  mockReplace.mockReset();
  mockSearch = "";
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({
      rows: [],
      nextCursor: null,
      items: [],
      total: 0,
      page: 1,
      perPage: 20,
      totalPaise: 0,
      totalRefundedPaise: 0,
      totalNetPaise: 0,
      byMember: [],
    }),
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

/** Picks 10 Nov 2026 as a one-day custom range in the date menu. */
function pickOneDay() {
  fireEvent.click(screen.getByRole("button", { name: "Date: Any date" }));
  fireEvent.click(screen.getByRole("button", { name: "Custom range…" }));
  fireEvent.change(screen.getByLabelText("From"), {
    target: { value: "2026-11-10" },
  });
  fireEvent.change(screen.getByLabelText("To"), {
    target: { value: "2026-11-10" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
}

// Local midnight of the day to the last millisecond of it, in the test's zone.
// 10 Nov as local instants: midnight to the last millisecond of the day.
const DAY_FROM = new Date(2026, 10, 10).toISOString();
const DAY_TO = new Date(new Date(2026, 10, 11).getTime() - 1).toISOString();

function lastQuery(path: string): URLSearchParams {
  const call = fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.startsWith(path))
    .pop();
  return new URL(call ?? path, "http://localhost").searchParams;
}

describe("org audit filter row", () => {
  it("sends a picked day as local-day instants and clears back", async () => {
    renderWithQuery(
      <AuditLogPage params={Promise.resolve({ orgId: "org-1" })} />,
    );
    pickOneDay();
    await waitFor(() =>
      expect(lastQuery("/api/organizations/org-1/audit?").get("from")).toBe(
        DAY_FROM,
      ),
    );
    expect(lastQuery("/api/organizations/org-1/audit?").get("to")).toBe(DAY_TO);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(lastQuery("/api/organizations/org-1/audit?").has("from")).toBe(
        false,
      ),
    );
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });
});

describe("member spend date filter", () => {
  it("sends local-day instants to the list and the CSV export", async () => {
    renderWithQuery(<MemberSpendPanel orgId="org-1" />);
    pickOneDay();
    await waitFor(() =>
      expect(
        lastQuery("/api/organizations/org-1/reimbursements?").get("from"),
      ).toBe(DAY_FROM),
    );
    expect(
      lastQuery("/api/organizations/org-1/reimbursements?").get("to"),
    ).toBe(DAY_TO);

    const href = screen
      .getByRole("link", { name: /Download CSV/ })
      .getAttribute("href");
    const exportParams = new URL(href ?? "", "http://localhost").searchParams;
    expect(exportParams.get("from")).toBe(DAY_FROM);
    expect(exportParams.get("to")).toBe(DAY_TO);
  });
});

describe("org appointments filter row", () => {
  it("keeps search, Type and Status inside the search landmark", () => {
    renderWithQuery(<AppointmentsPageClient orgId="org-1" />);
    const landmark = screen.getByRole("search", {
      name: "Filter organization appointments",
    });
    expect(
      screen.getByRole("searchbox", {
        name: "Search plan or member on this page",
      }),
    ).toHaveAttribute("placeholder", "Search plan or member on this page…");
    for (const name of ["Type", "Status"]) {
      expect(landmark).toContainElement(screen.getByRole("combobox", { name }));
    }
  });

  it("clears a URL type filter and resets the page", () => {
    mockSearch = "appointmentType=WEBINAR&page=3";
    renderWithQuery(<AppointmentsPageClient orgId="org-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(mockReplace).toHaveBeenCalledWith(
      "/dashboard/organization/org-1/appointments?",
      { scroll: false },
    );
  });
});
