import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("../../app/dashboard/organization/[orgId]/useOrgRole", () => ({
  useRequireOrgAccess: () => ({ allowed: true, isLoading: false }),
}));

import { OrgSupportTriage } from "@/app/dashboard/organization/[orgId]/support/OrgSupportTriage";

const row = {
  id: "case1",
  appointmentId: "appt1",
  category: "SESSION_ISSUE",
  status: "OPEN",
  activeChannel: "HUMAN",
  createdAt: "2026-10-01T00:00:00.000Z",
  lastMessageAt: "2026-10-02T00:00:00.000Z",
  resolvedAt: null,
  canCorrespond: false,
  member: { id: "m1", name: "Asha" },
  appointment: {
    appointmentType: "CONSULTATION",
    startsAt: null,
    planTitle: "Career call",
  },
};

let rows: Record<string, unknown>[] = [row];

function threads(sensitivePersonal: number) {
  return {
    data: rows,
    withheld: { sensitivePersonal },
    pagination: { page: 1, perPage: 30, total: 1, pages: 1 },
  };
}

function renderTriage(sensitivePersonal: number) {
  global.fetch = jest.fn(async (url: string) => {
    const body = String(url).includes("support-threads")
      ? threads(sensitivePersonal)
      : { data: null };
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <OrgSupportTriage orgId="org1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rows = [row];
});

describe("organization support triage", () => {
  it("says how many sensitive personal requests are withheld", async () => {
    renderTriage(2);
    expect(
      await screen.findByText(/2 personal requests are not listed/),
    ).toBeTruthy();
    expect(screen.getByText("Career call")).toBeTruthy();
  });

  it("lists a request that has no category", async () => {
    rows = [{ ...row, category: null }];
    renderTriage(0);
    expect(
      await screen.findByText(/Support request · last activity/),
    ).toBeTruthy();
  });

  it("says nothing when no request is withheld", async () => {
    renderTriage(0);
    await screen.findByText("Career call");
    await waitFor(() => expect(screen.queryByText(/not listed/)).toBeNull());
  });
});
