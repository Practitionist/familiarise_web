/**
 * @jest-environment jsdom
 */

// Org Billing: money tiles never share a phone-width row, so no amount is cut off.

jest.mock("../../lib/prisma", () => {
  // One posting at 23:33 UTC on 19 Oct: 20 Oct in India.
  const posting = {
    id: "entry-late",
    direction: "CREDIT",
    amountPaise: BigInt(118_000),
    createdAt: new Date("2026-10-19T23:33:00.000Z"),
    transaction: {
      kind: "INVOICE_PAYMENT",
      description: null,
      paymentId: null,
      invoiceId: null,
    },
  };
  return {
    __esModule: true,
    default: {
      $transaction: (reads: Promise<unknown>[]) => Promise.all(reads),
      ledgerAccount: { findUnique: async () => ({ id: "acct" }) },
      ledgerEntry: {
        groupBy: async () => [
          { direction: "CREDIT", _sum: { amountPaise: BigInt(118_000) } },
        ],
        count: async () => 1,
        findMany: async () => [posting],
      },
      payment: { findMany: async () => [] },
      organizationInvoice: { findMany: async () => [] },
    },
  };
});
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("../../lib/auth-client", () =>
  jest.requireActual("../fixtures/requests-inbox-mocks").signedOutAuthModule(),
);

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";

import { getOrgReceivables } from "@/lib/data/org-receivables";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";
import { AccruedUsagePanel } from "@/app/dashboard/organization/[orgId]/billing/AccruedUsagePanel";
import { InvoicesPanel } from "@/app/dashboard/organization/[orgId]/billing/InvoicesPanel";

const PROFILE_ZONE = "Asia/Kolkata";

async function usagePanel() {
  const receivables = JSON.parse(
    JSON.stringify(await getOrgReceivables("org-1", "OWNER")),
  );
  return (
    <DisplayZoneProvider zone={PROFILE_ZONE}>
      <AccruedUsagePanel receivables={receivables} />
    </DisplayZoneProvider>
  );
}

afterEach(() => jest.restoreAllMocks());

describe("money tiles at phone width", () => {
  const stacked = (label: string) => {
    const grid = screen.getByText(label).closest(".grid");
    expect(grid?.className.split(" ")).toEqual(
      expect.arrayContaining(["grid-cols-1", "sm:grid-cols-2"]),
    );
    expect(grid?.className.split(" ")).not.toContain("grid-cols-2");
  };

  it("stack one per row on the usage panel", async () => {
    render(await usagePanel());
    stacked("Unpaid balance");
  });

  it("stack one per row on the invoice summary", () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <InvoicesPanel
          orgId="org-1"
          summary={{
            data: {
              walletFrozen: false,
              walletFrozenReason: null,
              dunningSuspended: false,
              dunningSuspendedInvoiceNumber: null,
              fundingSource: "INVOICE",
              monthToDate: { net: 0, paymentCount: 0 },
              outstanding: { amount: 118_000, invoiceCount: 1 },
              pendingCharges: null,
              paymentTermsDays: 30,
              licenseContract: null,
            },
            isPending: false,
            isError: false,
            refetch: () => undefined,
          }}
          canPay={false}
          moneyMoveBlocked={false}
          moneyMoveReason=""
        />
      </QueryClientProvider>,
    );
    stacked("Outstanding");
  });
});
