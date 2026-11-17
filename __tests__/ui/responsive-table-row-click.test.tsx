/**
 * @jest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { BackofficeCapabilityProvider } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { OrgPayoutsTab } from "@/components/dashboard/backoffice/money/OrgPayoutsTab";
import { PayoutListSection } from "@/components/dashboard/backoffice/payouts/sections/PayoutListSection";
import PendingPayoutsSection from "@/components/dashboard/backoffice/payouts/sections/PendingPayoutsSection";
import { DisputesPage } from "@/components/dashboard/shared/DisputesPage";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

interface Row {
  id: string;
  label: string;
}

const COLUMNS: ResponsiveColumn<Row>[] = [
  {
    key: "label",
    header: "Label",
    primary: true,
    cell: (row) => (
      <div>
        <span>{row.label}</span>
        <span data-copyable="" title={row.id}>
          {row.id.slice(-8).toUpperCase()}
        </span>
      </div>
    ),
  },
];

const ROWS: Row[] = [{ id: "row-12345678", label: "Row one" }];

function renderTable(onRowClick: jest.Mock) {
  render(
    <ResponsiveTable<Row>
      columns={COLUMNS}
      rows={ROWS}
      getRowId={(row) => row.id}
      onRowClick={onRowClick}
    />,
  );
  return {
    labels: screen.getAllByText("Row one"),
    copyableIds: screen.getAllByText("12345678"),
  };
}

function selectElementText(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

afterEach(() => {
  cleanup();
  mockPush.mockReset();
  window.getSelection()?.removeAllRanges();
});

it("does not activate a row across a double-click selection sequence on a copyable ID", () => {
  const onRowClick = jest.fn();
  const { copyableIds } = renderTable(onRowClick);

  for (const idEl of copyableIds) {
    window.getSelection()?.removeAllRanges();
    // First click of a double-click fires before the browser populates the selection.
    fireEvent.mouseDown(idEl, { detail: 1 });
    fireEvent.mouseUp(idEl, { detail: 1 });
    fireEvent.click(idEl, { detail: 1 });

    // Second click populates the word selection and completes the double-click.
    fireEvent.mouseDown(idEl, { detail: 2 });
    selectElementText(idEl);
    fireEvent.mouseUp(idEl, { detail: 2 });
    fireEvent.click(idEl, { detail: 2 });
    fireEvent.dblClick(idEl, { detail: 2 });
  }

  expect(onRowClick).not.toHaveBeenCalled();
});

it("does not activate a row when the click ends a drag text selection", () => {
  const onRowClick = jest.fn();
  const { labels } = renderTable(onRowClick);
  selectElementText(labels[0]);

  fireEvent.click(labels[0]);

  expect(onRowClick).not.toHaveBeenCalled();
});

it("activates a row on a plain click after clearing an unrelated selection", () => {
  const onRowClick = jest.fn();
  const { labels } = renderTable(onRowClick);
  window.getSelection()?.removeAllRanges();

  fireEvent.click(labels[0]);

  expect(onRowClick).toHaveBeenCalledTimes(1);
});

it("ignores copyable ID clicks on getRowHref tables while following plain row clicks", () => {
  render(
    <ResponsiveTable<Row>
      columns={[
        { key: "label", header: "Label", primary: true, cell: (r) => r.label },
        {
          key: "id",
          header: "ID",
          cell: (r) => (
            <span data-copyable="" title={r.id}>
              {r.id.slice(-8).toUpperCase()}
            </span>
          ),
        },
      ]}
      rows={ROWS}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/rows/${r.id}`}
    />,
  );
  const link = document.querySelector<HTMLAnchorElement>("a[data-row-link]");
  const linkClick = jest.fn((e: MouseEvent) => e.preventDefault());
  link?.addEventListener("click", linkClick);

  const copyable = screen.getAllByText("12345678")[0];
  fireEvent.click(copyable, { detail: 1 });
  selectElementText(copyable);
  fireEvent.click(copyable, { detail: 2 });
  expect(linkClick).not.toHaveBeenCalled();

  window.getSelection()?.removeAllRanges();
  const row = copyable.closest("tr");
  if (row) fireEvent.click(row);
  expect(linkClick).toHaveBeenCalledTimes(1);
});

it("keeps internal dispute ID clicks and double-clicks from opening the dispute row", async () => {
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      disputes: [
        {
          id: "cm9dispute9876abcd",
          disputeId: "dp_external_123456",
          amountPaise: 50_000,
          currency: "INR",
          status: "NEEDS_RESPONSE",
          reason: "fraudulent",
          paymentGateway: "RAZORPAY",
          dueBy: null,
          createdAt: "2026-11-01T00:00:00.000Z",
          payment: {
            id: "pay-1",
            paymentIntent: "pay_intent_999999",
            buyer: { id: "user-1", name: "Priya Anderson", email: null },
            booking: null,
          },
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
      urgentDisputes: 0,
      stats: { underReviewCount: 0, wonCount: 0 },
    }),
  }) as unknown as typeof fetch;

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BackofficeCapabilityProvider
        value={{
          tree: "admin",
          basePath: "/dashboard/admin",
          role: "ADMIN",
          audience: "ADMIN",
        }}
        viewerId="admin-1"
      >
        <DisputesPage />
      </BackofficeCapabilityProvider>
    </QueryClientProvider>,
  );

  const internalIds = await waitFor(() => screen.getAllByText("9876ABCD"));
  for (const idButton of internalIds) {
    window.getSelection()?.removeAllRanges();
    fireEvent.click(idButton, { detail: 1 });
    selectElementText(idButton);
    fireEvent.click(idButton, { detail: 2 });
    fireEvent.dblClick(idButton, { detail: 2 });
  }

  expect(mockPush).not.toHaveBeenCalled();
  expect(writeText).toHaveBeenCalledWith("cm9dispute9876abcd");

  window.getSelection()?.removeAllRanges();
  fireEvent.click(screen.getAllByText("ernal_123456")[0]);
  expect(mockPush).toHaveBeenCalledWith(
    "/dashboard/admin/disputes/cm9dispute9876abcd",
  );
});

it("renders copyable short Payout IDs with full-ID titles across Payouts, Pending payouts, and Org payouts", async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/admin/org-payouts")) {
      return {
        ok: true,
        json: async () => ({
          payouts: [
            {
              id: "cm9orgpayout1122aabb",
              organizationId: "org-1",
              organization: { name: "Wipro", slug: "wipro" },
              amountPaise: 100_000,
              currency: "INR",
              status: "PENDING",
              createdAt: "2026-11-01T00:00:00.000Z",
              platformApprovalRequiredAt: null,
              platformHeldAt: null,
              createdByUser: null,
              orgApprovedByUser: null,
              approvedByUser: null,
            },
          ],
          pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
        }),
      } as Response;
    }
    return {
      ok: true,
      json: async () => ({
        payouts: [
          {
            id: url.includes("status=PENDING")
              ? "cm9pendpayout3344ccdd"
              : "cm9listpayout5566eeff",
            consultantProfileId: "cp-1",
            consultantUserId: "user-2",
            consultantName: "Aarav Anderson",
            consultantEmail: "aarav.anderson@gmail.com",
            amount: 75_000,
            currency: "INR",
            status: url.includes("status=PENDING") ? "PENDING" : "COMPLETED",
            method: "BANK_TRANSFER",
            provider: "RAZORPAY",
            earningsCount: 2,
            kind: null,
            mustPayByDate: null,
            createdAt: "2026-11-01T00:00:00.000Z",
            approvedAt: "2026-11-01T00:00:00.000Z",
            processedAt: null,
            failureReason: null,
          },
        ],
        pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
      }),
    } as Response;
  });

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BackofficeCapabilityProvider
        value={{
          tree: "admin",
          basePath: "/dashboard/admin",
          role: "ADMIN",
          audience: "ADMIN",
        }}
        viewerId="admin-1"
      >
        <PayoutListSection
          statuses={["COMPLETED"]}
          name="completed"
          empty="None"
        />
        <PendingPayoutsSection />
        <OrgPayoutsTab />
      </BackofficeCapabilityProvider>
    </QueryClientProvider>,
  );

  const listIds = await waitFor(() => screen.getAllByText("5566EEFF"));
  const pendingIds = await waitFor(() => screen.getAllByText("3344CCDD"));
  const orgIds = await waitFor(() => screen.getAllByText("1122AABB"));

  expect(listIds[0].getAttribute("title")).toBe("cm9listpayout5566eeff");
  expect(listIds[0].hasAttribute("data-copyable")).toBe(true);
  expect(pendingIds[0].getAttribute("title")).toBe("cm9pendpayout3344ccdd");
  expect(pendingIds[0].hasAttribute("data-copyable")).toBe(true);
  expect(orgIds[0].getAttribute("title")).toBe("cm9orgpayout1122aabb");
  expect(orgIds[0].hasAttribute("data-copyable")).toBe(true);
});
