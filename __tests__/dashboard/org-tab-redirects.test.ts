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
jest.mock("../../lib/booking/org-actor", () => ({
  isPayerAdminRole: (role: string) => role === "OWNER",
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
