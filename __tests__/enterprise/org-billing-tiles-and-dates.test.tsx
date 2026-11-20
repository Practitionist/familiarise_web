/**
 * @jest-environment jsdom
 */

// Org Billing: every date reads in one zone (invoice dates in IST, moments in
// the profile zone the layout pins), so a UTC server, an IST browser and a Los
// Angeles laptop print one day for one instant; money tiles never share a
// phone-width row, so no amount is cut off.

import "../fixtures/text-encoding";

// The reads reach payout setup, whose clawback notices load the email stack (unloadable in jsdom).
jest.mock("@/lib/payments/payouts/clawback-notifications", () =>
  jest
    .requireActual("../fixtures/requests-inbox-mocks")
    .clawbackNoticesModule(),
);
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
let mockSearch = "";
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockSearch),
}));
jest.mock("../../lib/auth-client", () =>
  jest.requireActual("../fixtures/requests-inbox-mocks").signedOutAuthModule(),
);

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

import { getOrgReceivables } from "@/lib/data/org-receivables";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";
import { AccruedUsagePanel } from "@/app/dashboard/organization/[orgId]/billing/AccruedUsagePanel";
import { InvoicesPanel } from "@/app/dashboard/organization/[orgId]/billing/InvoicesPanel";
import { LicensePanel } from "@/app/dashboard/organization/[orgId]/billing/LicensePanel";
import type { BillingSummary } from "@/app/dashboard/organization/[orgId]/billing/billing-api";

const PROFILE_ZONE = "Asia/Kolkata";

/** Locale date APIs print in `zone`, as they would in a runtime set to it. */
function runtimeZone(zone: string) {
  const original = Date.prototype.toLocaleDateString;
  return jest
    .spyOn(Date.prototype, "toLocaleDateString")
    .mockImplementation(function (this: Date, locales, options) {
      return original.call(this, locales, { timeZone: zone, ...options });
    });
}

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

afterEach(() => {
  jest.restoreAllMocks();
  mockSearch = "";
});

it("hydrates the Activity date a UTC server printed in an IST browser", async () => {
  const page = await usagePanel();
  const container = document.createElement("div");
  runtimeZone("UTC");
  container.innerHTML = renderToString(page);
  document.body.appendChild(container);
  jest.restoreAllMocks();

  runtimeZone(PROFILE_ZONE);
  const errors: unknown[] = [];
  jest.spyOn(console, "error").mockImplementation((e) => errors.push(e));
  await act(async () => {
    hydrateRoot(container, page, {
      onRecoverableError: (error) => errors.push(error),
    });
  });
  const printed = container.textContent;
  container.remove();
  expect(errors).toEqual([]);
  expect(printed).toContain("20 Oct 2026");
});

// 23:33 UTC on 19 Oct is 20 Oct in India and still 19 Oct in Los Angeles.
const LATE_UTC = "2026-10-19T23:33:00.000Z";

const summaryOf = (
  licenseContract: BillingSummary["licenseContract"] = null,
): BillingSummary => ({
  walletFrozen: false,
  walletFrozenReason: null,
  dunningSuspended: false,
  dunningSuspendedInvoiceNumber: null,
  fundingSource: "INVOICE",
  monthToDate: { net: 0, paymentCount: 0 },
  outstanding: { amount: 118_000, invoiceCount: 1 },
  pendingCharges: null,
  paymentTermsDays: 30,
  licenseContract,
});

const invoicesPanel = () => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <DisplayZoneProvider zone={PROFILE_ZONE}>
      <InvoicesPanel
        orgId="org-1"
        summary={{
          data: summaryOf(),
          isPending: false,
          isError: false,
          refetch: () => undefined,
        }}
        canPay={false}
        moneyMoveBlocked={false}
        moneyMoveReason=""
      />
    </DisplayZoneProvider>
  </QueryClientProvider>
);

describe("one instant prints one day in a Los Angeles browser", () => {
  it("in the invoice list and the invoice drawer", async () => {
    runtimeZone("America/Los_Angeles");
    mockSearch = "invoice=inv-1";
    const invoice = {
      id: "inv-1",
      invoiceNumber: "FAM-ORG-0001",
      totalPaise: 118_000,
      displayCurrency: "INR",
      status: "ISSUED",
      issuedAt: LATE_UTC,
      dueDate: LATE_UTC,
      paidAt: null,
      autoGenerated: true,
      createdAt: "2026-09-19T10:00:00.000Z",
    };
    const bodies: Record<string, unknown> = {
      "/api/organizations/org-1/billing-account/invoices?perPage=50": {
        data: [invoice],
      },
      "/api/organizations/org-1/billing-account/invoices/inv-1": {
        invoice: {
          ...invoice,
          subtotalPaise: 100_000,
          igstPaise: 18_000,
          cgstPaise: 0,
          sgstPaise: 0,
          billingCycleStart: null,
          billingCycleEnd: null,
          lineItems: [],
          creditNotes: [],
        },
      },
    };
    global.fetch = jest.fn(async (url: string) => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => bodies[url],
    })) as unknown as typeof fetch;

    render(invoicesPanel());

    const drawer = await screen.findByRole("dialog");
    await within(drawer).findByText("Subtotal");
    expect(within(drawer).getAllByText("20 Oct 2026")).toHaveLength(2);
    // The list row behind the open drawer (table cell and phone card) prints the same day.
    const listed = screen
      .getAllByText("20 Oct 2026")
      .filter((el) => !drawer.contains(el));
    expect(listed.length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("19 Oct");
  });

  it("on the licence terms", () => {
    runtimeZone("America/Los_Angeles");
    render(
      <DisplayZoneProvider zone={PROFILE_ZONE}>
        <LicensePanel
          summary={summaryOf({
            id: "contract-1",
            effectiveFrom: LATE_UTC,
            effectiveTo: null,
            autoRenew: true,
            subscription: {
              model: "FLAT_FEE",
              cycle: "ANNUAL",
              flatFeePaise: 1_000_000,
              currentCycleStart: LATE_UTC,
              currentCycleEnd: LATE_UTC,
              nextInvoiceDate: LATE_UTC,
            },
          })}
        />
      </DisplayZoneProvider>,
    );
    expect(screen.getByText("20 Oct 2026 – 20 Oct 2026")).toBeTruthy();
    expect(screen.getByText("20 Oct 2026")).toBeTruthy();
  });
});

describe("money tiles at phone width", () => {
  /** The tile row's column count on a phone and from sm. */
  const phoneColumns = (label: string) =>
    (
      screen.getByText(label).closest(".grid")?.className.split(" ") ?? []
    ).filter((c) => /^(sm:)?grid-cols-\d$/.test(c));

  it("stack one per row on the usage panel", async () => {
    render(await usagePanel());
    expect(phoneColumns("Unpaid balance")).toEqual([
      "grid-cols-1",
      "sm:grid-cols-2",
    ]);
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
    expect(phoneColumns("Outstanding")).toEqual([
      "grid-cols-1",
      "sm:grid-cols-2",
    ]);
  });
});
