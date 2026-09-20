/**
 * @jest-environment node
 */

/**
 * #1744 row 6 — the org DELETE wind-down gate counted contracts, invoices,
 * purchase orders, earnings, payouts and the wallet, but not money that had
 * accrued and not yet reached an invoice. An INVOICE-rail booking awaiting the
 * monthly rollup, or a PENDING/ACCRUED overage, vanished with the org. Pins
 * that one unbilled accrual is refused with its count.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(),
  requireOrgOwner: jest.fn(async () => ({
    error: null,
    member: { id: "mem_1", role: "OWNER" },
  })),
}));

jest.mock("../../lib/data/public-cache", () => ({
  purgeOrgSurfaces: jest.fn(),
}));

const paymentCount = jest.fn();
const overageCount = jest.fn();
const orgDelete = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        organization: {
          findUnique: async () => ({
            deletedAt: null,
            billingAccount: { walletBalance: 0 },
            _count: {
              contracts: 0,
              invoices: 0,
              purchaseOrders: 0,
              earnings: 0,
              payouts: 0,
            },
          }),
          delete: orgDelete,
        },
        payment: { count: paymentCount },
        overageEvent: { count: overageCount },
      }),
  },
}));

import { NextRequest } from "next/server";

import { DELETE } from "../../app/api/organizations/[orgId]/route";

function del() {
  return DELETE(
    new NextRequest("https://x.test/api/organizations/org_1", {
      method: "DELETE",
    }),
    { params: Promise.resolve({ orgId: "org_1" }) },
  );
}

describe("DELETE /api/organizations/[orgId] — wind-down counts accruals", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    overageCount.mockResolvedValue(0);
  });

  it("refuses an org with one unbilled invoice accrual, naming the count", async () => {
    paymentCount.mockResolvedValue(1);

    const res = await del();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("1 unbilled invoice accrual(s)");
    expect(orgDelete).not.toHaveBeenCalled();
    // The count is scoped to unbilled, succeeded, accrual-legged payments.
    expect(paymentCount.mock.calls[0][0].where).toMatchObject({
      organizationId: "org_1",
      paymentStatus: "SUCCEEDED",
      billableToOrgInvoiceId: null,
    });
  });

  it("refuses an org with an unsettled overage charge", async () => {
    paymentCount.mockResolvedValue(0);
    overageCount.mockResolvedValue(2);

    const res = await del();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("2 unsettled overage charge(s)");
    expect(overageCount.mock.calls[0][0].where).toMatchObject({
      chargeStatus: { in: ["PENDING", "ACCRUED"] },
    });
  });
});
