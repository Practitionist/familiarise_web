/**
 * @jest-environment node
 */

/**
 * #1527 Q7 — retired org routes became tabs and answer a 308 that keeps the
 * old query. One pin per redirect page.
 */

const mockPermanentRedirect = jest.fn((path: string) => {
  throw new Error(`NEXT_PERMANENT_REDIRECT:${path}`);
});

jest.mock("next/navigation", () => ({
  __esModule: true,
  permanentRedirect: (path: string) => mockPermanentRedirect(path),
  redirect: jest.fn(),
  notFound: jest.fn(),
}));
// A payer admin with no consultant profile: Requests 308s to Unscheduled.
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: async () => ({
    member: { role: "OWNER", consultantProfileId: null },
  }),
}));
jest.mock(
  "../../app/dashboard/organization/[orgId]/requests/RequestsClient",
  () => ({ RequestsClient: () => null }),
);

import PurchaseOrders from "../../app/dashboard/organization/[orgId]/purchase-orders/page";
import Disputes from "../../app/dashboard/organization/[orgId]/disputes/page";
import Reimbursements from "../../app/dashboard/organization/[orgId]/reimbursements/page";
import Materials from "../../app/dashboard/organization/[orgId]/materials/page";
import Requests from "../../app/dashboard/organization/[orgId]/requests/page";
import {
  ORG_PAGE_TAB_MAP,
  orgLegacyTabHref,
  type OrgTabbedPage,
} from "../../lib/dashboard/org-tab-redirect";

type RedirectPage = (props: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => Promise<unknown>;

const base = "/dashboard/organization/org-1";

describe("retired org routes 308 to their tab", () => {
  it.each<[string, RedirectPage, string]>([
    [
      "purchase-orders",
      PurchaseOrders,
      `${base}/billing?q=PO-7&tab=purchase-orders`,
    ],
    ["disputes", Disputes, `${base}/billing?q=PO-7&tab=disputes`],
    [
      "reimbursements",
      Reimbursements,
      `${base}/billing?q=PO-7&tab=member-spend`,
    ],
    ["materials", Materials, `${base}/catalog?q=PO-7&tab=materials`],
    // #1527 QA wave 3 — it used to drop the query.
    ["requests", Requests, `${base}/appointments?q=PO-7&tab=unscheduled`],
  ])("%s", async (_name, Page, target) => {
    await expect(
      Page({
        params: Promise.resolve({ orgId: "org-1" }),
        // A stale `tab` never wins over the destination tab.
        searchParams: Promise.resolve({ q: "PO-7", tab: "old" }),
      }),
    ).rejects.toThrow("NEXT_PERMANENT_REDIRECT");
    expect(mockPermanentRedirect).toHaveBeenLastCalledWith(target);
  });
});

describe("every old Billing, Payouts and Catalog ?tab= lands on its new tab", () => {
  // Null: the value is a current tab and the URL stays as it is.
  const EXPECTED: Record<OrgTabbedPage, Record<string, string | null>> = {
    billing: {
      invoices: null,
      "accrued-usage": `${base}/billing?q=1&tab=invoices#accrued-usage`,
      wallet: null,
      license: `${base}/billing?q=1&tab=wallet#license`,
      "purchase-orders": null,
      disputes: null,
      "member-spend": null,
    },
    payouts: {
      runs: null,
      earnings: `${base}/payouts?q=1&tab=runs#earnings`,
      "payout-account": null,
      "rate-cards": null,
      "expert-routing": `${base}/payouts?q=1&tab=rate-cards#expert-routing`,
    },
    catalog: {
      webinars: null,
      classes: null,
      archived: `${base}/catalog?q=1&status=archived`,
      materials: null,
      collaborators: `${base}/collaborators?q=1`,
    },
  };

  const cases = (Object.keys(EXPECTED) as OrgTabbedPage[]).flatMap((page) =>
    Object.entries(EXPECTED[page]).map(
      ([tab, href]) => [page, tab, href] as const,
    ),
  );

  it("covers every mapped value", () => {
    for (const page of Object.keys(ORG_PAGE_TAB_MAP) as OrgTabbedPage[]) {
      expect(Object.keys(EXPECTED[page]).sort()).toEqual(
        Object.keys(ORG_PAGE_TAB_MAP[page]).sort(),
      );
    }
  });

  it.each(cases)("%s?tab=%s", (page, tab, href) => {
    expect(orgLegacyTabHref("org-1", page, { q: "1", tab })).toBe(href);
  });

  it("leaves a missing or unknown tab to the page's first tab", () => {
    expect(orgLegacyTabHref("org-1", "billing", {})).toBeNull();
    expect(orgLegacyTabHref("org-1", "payouts", { tab: "nope" })).toBeNull();
  });
});
