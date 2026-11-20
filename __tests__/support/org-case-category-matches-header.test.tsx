/**
 * The org Support list names a case's category with the same topic its case
 * page header reads (`ticketTopic`), so one case never reads "Billing" in the
 * list and "Other" on its page.
 */

import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/useListParams", () => ({
  useListParams: () => ({ page: 1, setPage: jest.fn() }),
}));
jest.mock("@/lib/time/use-zone-clock", () => ({
  useZoneClock: () => ({ date: (iso: string) => iso.slice(0, 10) }),
}));

import { OrgSupportRequests } from "@/app/dashboard/organization/[orgId]/support/OrgSupportRequests";
import { CASE_TOPIC_LABEL, ticketTopic } from "@/lib/support/case-topic";

/** Rows as GET /api/organizations/[orgId]/support-tickets returns them for the shared database's cases. */
const ROWS = [
  {
    id: "case-billing",
    referenceNumber: "FAM-2026-000002",
    title: "Invoice question",
    issueType: null,
    category: "BILLING",
    status: "OPEN",
    createdAt: "2026-11-02T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    requesterName: "Tour Owner",
  },
  {
    id: "case-quality",
    referenceNumber: "FAM-2026-000001",
    title: "Session quality",
    issueType: null,
    category: "QUALITY_COMPLAINT",
    status: "OPEN",
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    requesterName: "Tour Owner",
  },
];

beforeEach(() => {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ data: ROWS, total: 2, page: 1, pageSize: 20 }),
  })) as unknown as typeof fetch;
});

it("reads each case's category as its page header does", async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <OrgSupportRequests orgId="org-wipro" />
    </QueryClientProvider>,
  );

  for (const row of ROWS) {
    const header = CASE_TOPIC_LABEL[ticketTopic(row)];
    const [tableRow] = (await screen.findAllByText(row.title))
      .map((el) => el.closest("tr"))
      .filter((tr): tr is HTMLTableRowElement => tr !== null);
    expect(tableRow).toBeDefined();
    expect(within(tableRow!).getByText(header)).toBeInTheDocument();
  }
  expect(screen.queryByText("Billing")).toBeNull();
});
