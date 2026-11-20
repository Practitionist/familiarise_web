/**
 * Workspace Spend and Overview: the headline totals cover active organisations
 * only; a deactivated organisation sits in a collapsed group on both pages.
 */

import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const ACTIVE = "org-wipro";
const GONE = "org-qa-pool";

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    membership: {
      findMany: async () => [
        {
          id: "m-wipro",
          role: "OWNER",
          status: "ACTIVE",
          organizationId: ACTIVE,
          organization: {
            id: ACTIVE,
            canSponsor: true,
            canHost: false,
            brandingProfile: null,
            name: "Wipro Limited",
            slug: "wipro",
            status: "ACTIVE",
            billingAccount: {
              id: "ba-wipro",
              walletBalance: 0,
              minBalancePaise: null,
              currency: "INR",
              fundingSource: "INVOICE",
            },
          },
        },
        {
          id: "m-pool",
          role: "OWNER",
          status: "ACTIVE",
          organizationId: GONE,
          organization: {
            id: GONE,
            canSponsor: true,
            canHost: false,
            brandingProfile: null,
            name: "qa2205 Pool Org",
            slug: "qa2205-pool",
            status: "DEACTIVATED",
            billingAccount: {
              id: "ba-pool",
              walletBalance: 4_000_000,
              minBalancePaise: null,
              currency: "INR",
              fundingSource: "WALLET",
            },
          },
        },
      ],
      groupBy: async () => [
        { organizationId: ACTIVE, _count: { _all: 25 } },
        { organizationId: GONE, _count: { _all: 3 } },
      ],
    },
    organizationInvoice: {
      groupBy: async () => [
        {
          billingAccountId: "ba-wipro",
          _sum: { totalPaise: 118_000 },
          _count: { _all: 1 },
        },
        {
          billingAccountId: "ba-pool",
          _sum: { totalPaise: 50_000 },
          _count: { _all: 1 },
        },
      ],
    },
  },
}));

let mockRollup: unknown;
jest.mock(
  "@/app/dashboard/org-workspace/[orgWorkspaceId]/hooks/useWorkspaceBilling",
  () => ({
    useWorkspaceBilling: () => ({
      data: mockRollup,
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    }),
  }),
);

import {
  getOperatorOrganizations,
  getWorkspaceBillingRollup,
} from "@/lib/data/org-workspace";
import { HomePageClient } from "@/app/dashboard/org-workspace/[orgWorkspaceId]/home/HomePageClient";
import { BillingPageClient } from "@/app/dashboard/org-workspace/[orgWorkspaceId]/billing/BillingPageClient";
import { formatCurrencyTotals } from "@/app/dashboard/org-workspace/[orgWorkspaceId]/currency-totals";

describe("workspace Spend", () => {
  it("totals only active organisations", async () => {
    const rollup = await getWorkspaceBillingRollup("u-owner");
    expect(rollup.summary).toEqual({
      activeOrgs: 1,
      inactiveOrgs: 1,
      totalActiveMembers: 25,
      outstandingByCurrency: [{ currency: "INR", paise: 118_000 }],
      walletByCurrency: [{ currency: "INR", paise: 0 }],
    });
    expect(rollup.perOrg.map((o) => o.organizationId)).toEqual([ACTIVE, GONE]);
    expect(formatCurrencyTotals([])).toBe("—");
  });

  it("lists a deactivated organisation in a collapsed group, outside the headline", async () => {
    mockRollup = await getWorkspaceBillingRollup("u-owner");
    render(<BillingPageClient orgWorkspaceId="ws-1" />);

    const tile = (label: string) =>
      screen.getAllByText(label)[0]?.parentElement?.parentElement;
    expect(tile("Funded orgs")).toHaveTextContent(/^Funded orgs1active/);
    expect(tile("Wallet balance")).toHaveTextContent(/^Wallet balance₹0\.00/);
    expect(tile("Outstanding")).toHaveTextContent(/₹1,180\.00across 1 active/);

    const group = screen.getByText(/Not active \(1\)/).closest("details");
    expect(group).not.toBeNull();
    expect(group).not.toHaveAttribute("open");
    expect(
      within(group!).getAllByText("qa2205 Pool Org").length,
    ).toBeGreaterThan(0);
    expect(within(group!).getAllByText(/· Deactivated/)[0]).toBeInTheDocument();

    for (const name of screen.getAllByText("qa2205 Pool Org")) {
      expect(group).toContainElement(name);
    }
  });

  it("Overview puts a deactivated organisation in the same collapsed group", async () => {
    mockRollup = await getWorkspaceBillingRollup("u-owner");
    const client = new QueryClient();
    client.setQueryData(
      ["org-workspace-orgs"],
      await getOperatorOrganizations("u-owner"),
    );
    render(
      <QueryClientProvider client={client}>
        <HomePageClient orgWorkspaceId="ws-1" />
      </QueryClientProvider>,
    );

    expect(screen.getByText("₹0.00")).toBeInTheDocument();
    const group = screen.getByText(/Not active \(1\)/).closest("details");
    expect(group).not.toBeNull();
    expect(group).not.toHaveAttribute("open");
    expect(group).toContainElement(screen.getByText("qa2205 Pool Org"));
    expect(group).not.toContainElement(screen.getByText("Wipro Limited"));
    expect(screen.getByText("Owner (1)")).toBeInTheDocument();
  });
});
