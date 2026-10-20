/**
 * @jest-environment node
 */

/**
 * The org billing tile reports what the org's own money spent this month: a member's card
 * payment tagged to the org is not counted, and SUCCEEDED refunds are netted out.
 */

jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(async () => ({ error: null })),
}));
jest.mock("../../lib/payments/wallet-freeze", () => ({
  isWalletFrozen: jest.fn(async () => false),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    billingAccount: { findFirst: jest.fn(async () => null) },
    paymentLeg: { aggregate: jest.fn() },
    payment: { aggregate: jest.fn() },
    refund: { aggregate: jest.fn() },
    organizationInvoice: {
      aggregate: jest.fn(async () => ({
        _sum: { totalPaise: null },
        _count: { _all: 0 },
      })),
      findFirst: jest.fn(async () => null),
    },
    organization: {
      findUnique: jest.fn(async () => ({ paymentTermsDays: 30 })),
    },
  },
}));

import { NextRequest } from "next/server";
import { GET } from "../../app/api/organizations/[orgId]/billing/route";
import prisma from "@/lib/prisma";

it("counts only org-rail payments and reports them net of refunds", async () => {
  (prisma.payment.aggregate as jest.Mock).mockResolvedValue({
    _sum: { amount: 100_000 },
    _count: { _all: 2 },
  });
  (prisma.refund.aggregate as jest.Mock).mockResolvedValue({
    _sum: { amountPaise: 40_000 },
  });

  const res = await GET(
    new NextRequest("https://x.test/api/organizations/org-1/billing"),
    {
      params: Promise.resolve({ orgId: "org-1" }),
    },
  );
  const body = await res.json();

  expect(body.monthToDate).toEqual({ net: 60_000, paymentCount: 2 });
  const paymentWhere = (prisma.payment.aggregate as jest.Mock).mock.calls[0][0]
    .where;
  expect(paymentWhere).toMatchObject({
    organizationId: "org-1",
    paymentMethod: { in: ["WALLET", "INVOICE", "LICENSE"] },
    paymentStatus: "SUCCEEDED",
  });
  expect((prisma.refund.aggregate as jest.Mock).mock.calls[0][0].where).toEqual(
    {
      status: "SUCCEEDED",
      payment: paymentWhere,
    },
  );
});

it("reports pendingCharges net of refund reversal legs, the figure the credit-limit exposure reads", async () => {
  (prisma.billingAccount.findFirst as jest.Mock).mockResolvedValueOnce({
    id: "ba-1",
    fundingSource: "INVOICE",
    creditLimit: null,
  });
  (prisma.payment.aggregate as jest.Mock).mockResolvedValue({
    _sum: { amount: 0 },
    _count: { _all: 3 },
  });
  (prisma.refund.aggregate as jest.Mock).mockResolvedValue({
    _sum: { amountPaise: 0 },
  });
  (prisma.paymentLeg.aggregate as jest.Mock).mockResolvedValue({
    _sum: { amountPaise: 70_000 },
  });

  const res = await GET(
    new NextRequest("https://x.test/api/organizations/org-1/billing"),
    { params: Promise.resolve({ orgId: "org-1" }) },
  );
  const body = await res.json();

  expect(body.pendingCharges).toEqual({ amount: 70_000, paymentCount: 3 });
  const where = (prisma.paymentLeg.aggregate as jest.Mock).mock.calls[0][0]
    .where;
  expect(where.source.in).toEqual(
    expect.arrayContaining([
      "INVOICE_ACCRUAL_REVERSAL",
      "OVERAGE_INVOICE_ACCRUAL_REVERSAL",
    ]),
  );
});

it.each([null, 0])(
  "reports zero pendingCharges when the net accrual sums to %p",
  async (amountPaise) => {
    (prisma.billingAccount.findFirst as jest.Mock).mockResolvedValueOnce({
      id: "ba-1",
      fundingSource: "INVOICE",
      creditLimit: null,
    });
    (prisma.payment.aggregate as jest.Mock).mockResolvedValue({
      _sum: { amount: 0 },
      _count: { _all: 0 },
    });
    (prisma.refund.aggregate as jest.Mock).mockResolvedValue({
      _sum: { amountPaise: 0 },
    });
    (prisma.paymentLeg.aggregate as jest.Mock).mockResolvedValueOnce({
      _sum: { amountPaise },
    });

    const res = await GET(
      new NextRequest("https://x.test/api/organizations/org-1/billing"),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );

    expect((await res.json()).pendingCharges).toEqual({
      amount: 0,
      paymentCount: 0,
    });
  },
);
