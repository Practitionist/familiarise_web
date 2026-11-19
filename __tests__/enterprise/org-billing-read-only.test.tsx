/**
 * @jest-environment jsdom
 */

/**
 * A finance reader without billing.manage (MAINTAINER, MANAGER) sees Billing
 * read-only: the page says so and names the role that can act, instead of
 * leaving controls missing with no reason.
 */

import type { MemberRole } from "@prisma/client";
import type { OrgSurface } from "@/lib/auth/org-permissions";

let mockRole: MemberRole = "MANAGER";

// The real permission matrix, with the viewer's role swapped per test.
jest.mock("../../app/dashboard/organization/[orgId]/useOrgRole", () => {
  const { hasOrgPermission } = jest.requireActual(
    "../../lib/auth/org-permissions",
  );
  return {
    useOrgRole: () => ({
      role: mockRole,
      isLoading: false,
      can: (surface: OrgSurface) => hasOrgPermission(mockRole, surface),
    }),
    useRequireOrgAccess: () => ({ allowed: true, isLoading: false }),
  };
});
jest.mock(
  "../../app/dashboard/organization/[orgId]/billing/billing-api",
  () => ({
    ...jest.requireActual(
      "../../app/dashboard/organization/[orgId]/billing/billing-api",
    ),
    fetchBilling: jest.fn(async () => ({ fundingSource: "INVOICE" })),
  }),
);
jest.mock("../../lib/api/organizations/org-details", () => ({
  orgDetailsQueryKey: (id: string) => ["org-details", id],
  fetchOrgDetails: jest.fn(async () => ({
    organization: { name: "Wipro Limited", status: "ACTIVE" },
  })),
}));
// The page's panels each have their own pins; here they only take up a slot.
jest.mock(
  "../../app/dashboard/organization/[orgId]/billing/InvoicesPanel",
  () => ({ InvoicesPanel: () => null }),
);
jest.mock(
  "../../app/dashboard/organization/[orgId]/billing/AccruedUsagePanel",
  () => ({ AccruedUsagePanel: () => null }),
);
jest.mock("../../app/dashboard/organization/[orgId]/billing/WalletTab", () => ({
  WalletTab: () => null,
}));
jest.mock(
  "../../app/dashboard/organization/[orgId]/disputes/DisputesPanel",
  () => ({ DisputesPanel: () => null }),
);
jest.mock(
  "../../app/dashboard/organization/[orgId]/reimbursements/MemberSpendPanel",
  () => ({ MemberSpendPanel: () => null }),
);
jest.mock(
  "../../app/dashboard/organization/[orgId]/purchase-orders/PurchaseOrdersPanel",
  () => ({ PurchaseOrdersPanel: () => null }),
);
jest.mock(
  "../../app/dashboard/organization/[orgId]/purchase-orders/utils/api",
  () => ({
    fetchPurchaseOrders: jest.fn(async () => ({
      data: [
        {
          id: "po-1",
          poNumber: "WIPRO-PO-1",
          poDate: "2026-09-01T00:00:00.000Z",
          validUntil: null,
          totalAmountPaise: 500_000_000,
          remainingAmountPaise: 499_764_000,
          currency: "INR",
          status: "ACTIVE",
          uploadedDocUrl: null,
          createdAt: "2026-09-01T00:00:00.000Z",
          _count: { contracts: 1, invoices: 4 },
        },
      ],
    })),
  }),
);
jest.mock(
  "../../components/dashboard/shared/support/CreateTicketDialog",
  () => ({
    CreateTicketDialog: ({ trigger }: { trigger: React.ReactNode }) => trigger,
  }),
);
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/organization/org-1/billing",
}));

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BillingPageClient } from "../../app/dashboard/organization/[orgId]/billing/BillingPageClient";
import { shownDueDate } from "../../app/dashboard/organization/[orgId]/billing/billing-api";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(node: React.ReactNode): Promise<string> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>{node}</QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container.textContent ?? "";
}

describe("Billing for a reader without billing.manage", () => {
  const READ_ONLY_LINE =
    "Paying or requesting an invoice needs the Owner or Billing admin role";

  it.each<MemberRole>(["MANAGER", "MAINTAINER"])(
    "tells a %s who can act",
    async (role) => {
      mockRole = role;
      const text = await render(<BillingPageClient orgId="org-1" />);
      expect(text).toContain(READ_ONLY_LINE);
      expect(text).not.toContain("Request an invoice");
    },
  );

  it("says nothing extra to a role that can act", async () => {
    mockRole = "OWNER";
    const text = await render(<BillingPageClient orgId="org-1" />);
    expect(text).not.toContain(READ_ONLY_LINE);
  });

  it("shows no due date on an invoice that is never due", () => {
    const dueDate = "2026-11-19T16:46:45.396Z";
    expect(shownDueDate({ status: "VOID", dueDate })).toBeNull();
    expect(shownDueDate({ status: "DRAFT", dueDate })).toBeNull();
    expect(shownDueDate({ status: "ISSUED", dueDate })).toBe(dueDate);
  });
});

describe("Purchase orders for a reader without purchaseOrders.manage", () => {
  // The page module above is a stub; the real panel is rendered here.
  const { PurchaseOrdersPanel } = jest.requireActual(
    "../../app/dashboard/organization/[orgId]/purchase-orders/PurchaseOrdersPanel",
  );

  it("names who can act, in words, with no developer copy", async () => {
    mockRole = "MAINTAINER";
    const text = await render(<PurchaseOrdersPanel orgId="org-1" />);
    expect(text).toContain(
      "adding, editing or cancelling one needs the Owner or Billing admin role",
    );
    expect(text).toContain("1 contract · 4 invoices");
    expect(text).not.toContain("Caller-issued");
    expect(text).not.toContain("Cancel one to retire it");
    expect(text).not.toContain("New PO");
  });
});
