/**
 * @jest-environment node
 */

/**
 * #1527 Q5 — the payment detail read answers only for a top-level charge the
 * profile's own user paid; any other id reads as not found, before any
 * refund or credit-note read runs.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findFirst: jest.fn() },
    refund: { findMany: jest.fn() },
    consumerCreditNote: { findMany: jest.fn() },
  },
}));

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import prisma from "@/lib/prisma";
import { PaymentDetailClient } from "@/app/dashboard/consultee/[consulteeId]/(features)/payments/[paymentId]/PaymentDetailClient";
import {
  readConsulteePaymentDetail,
  REFUND_FAILED_NOTICE,
} from "@/lib/data/consultee-payment-detail";

it("binds the charge to the payer and answers null for anyone else's", async () => {
  (prisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
  const detail = await readConsulteePaymentDetail({
    paymentId: "pay-1",
    consulteeId: "ce-1",
    userId: "user-1",
    viewerZone: "UTC",
  });
  expect(detail).toBeNull();
  expect(
    (prisma.payment.findFirst as jest.Mock).mock.calls[0][0].where,
  ).toEqual({
    id: "pay-1",
    userId: "user-1",
    user: { consulteeProfileId: "ce-1" },
    parentPaymentId: null,
    deletedAt: null,
  });
  expect(prisma.refund.findMany).not.toHaveBeenCalled();
});

it("answers null for another user's payment and never reads its refunds", async () => {
  const rows = [{ id: "pay-1", userId: "user-owner" }];
  (prisma.payment.findFirst as jest.Mock).mockImplementation(
    async ({ where }: { where: { id: string; userId: string } }) =>
      rows.find((r) => r.id === where.id && r.userId === where.userId) ?? null,
  );
  (prisma.refund.findMany as jest.Mock).mockClear();
  const detail = await readConsulteePaymentDetail({
    paymentId: "pay-1",
    consulteeId: "ce-9",
    userId: "user-intruder",
    viewerZone: "UTC",
  });
  expect(detail).toBeNull();
  expect(prisma.refund.findMany).not.toHaveBeenCalled();
});

it("never selects or returns the gateway's raw refund failure text", async () => {
  const raw = "BAD_REQUEST_ERROR: insufficient balance in merchant account";
  const at = new Date("2026-09-01T10:00:00Z");
  (prisma.payment.findFirst as jest.Mock).mockResolvedValue({
    id: "pay-1",
    amount: 50000,
    originalAmount: 50000,
    taxAmount: 0,
    currency: "INR",
    paymentStatus: "SUCCEEDED",
    paymentMethod: "card",
    paymentGateway: "RAZORPAY",
    paymentIntent: "order_Nx79",
    receiptUrl: null,
    expiresAt: null,
    createdAt: at,
    consumerInvoice: null,
    legs: [],
    refunds: [],
    disputes: [],
    organizationId: null,
    organization: null,
    discountCode: null,
    childPayments: [],
    creditUsages: [],
    appointment: null,
  });
  (prisma.refund.findMany as jest.Mock).mockImplementation(
    async ({ select }: { select: Record<string, boolean> }) => [
      {
        id: "ref-1",
        amountPaise: 50000,
        currency: "INR",
        status: "FAILED",
        refundId: "rfnd_ABC123",
        createdAt: at,
        updatedAt: at,
        ...(select.failureReason ? { failureReason: raw } : {}),
      },
    ],
  );
  const detail = await readConsulteePaymentDetail({
    paymentId: "pay-1",
    consulteeId: "ce-1",
    userId: "user-1",
    viewerZone: "UTC",
  });
  const select = (prisma.refund.findMany as jest.Mock).mock.calls[0][0].select;
  expect(select).not.toHaveProperty("failureReason");
  expect(detail?.refunds[0]).toMatchObject({
    failureNotice: REFUND_FAILED_NOTICE,
    gatewayRefundId: "rfnd_ABC123",
  });
  expect(JSON.stringify(detail)).not.toContain(raw);
});

describe("the detail page when nothing was charged", () => {
  const record = (over: Record<string, unknown>) => ({
    id: "pay-1",
    amount: 50000,
    originalAmount: 50000,
    taxAmount: 0,
    currency: "INR",
    paymentStatus: "SUCCEEDED",
    paymentMethod: "card",
    paymentGateway: "RAZORPAY",
    paymentIntent: "order_Nx80",
    receiptUrl: null,
    expiresAt: null,
    createdAt: new Date("2026-09-01T10:00:00Z"),
    consumerInvoice: null,
    legs: [],
    refunds: [],
    disputes: [],
    organizationId: null,
    organization: null,
    discountCode: null,
    childPayments: [],
    creditUsages: [],
    appointment: null,
    ...over,
  });
  const page = async (over: Record<string, unknown>) => {
    (prisma.payment.findFirst as jest.Mock).mockResolvedValue(record(over));
    (prisma.refund.findMany as jest.Mock).mockResolvedValue([]);
    const detail = await readConsulteePaymentDetail({
      paymentId: "pay-1",
      consulteeId: "ce-1",
      userId: "user-1",
      viewerZone: "UTC",
    });
    if (!detail) throw new Error("no detail");
    return {
      detail,
      html: renderToStaticMarkup(
        React.createElement(PaymentDetailClient, {
          consulteeId: "ce-1",
          detail,
        }),
      ),
    };
  };

  it("a ₹0 payment says Free once and offers no charge dispute", async () => {
    const { detail, html } = await page({ amount: 0, originalAmount: 0 });
    expect(detail.moneyState.label).toBe("Free");
    expect(html.split(">Free<")).toHaveLength(2);
    expect(html).not.toContain("Problem with this charge");
  });

  it("a hold that lapsed before its gateway order existed labels its amount Would have been and offers no dispute", async () => {
    const { detail, html } = await page({
      paymentStatus: "EXPIRED",
      paymentIntent: "premint_9f2c",
      amount: 161_444,
      originalAmount: 161_444,
    });
    expect(detail.moneyState.line).toBe(
      "Nothing was charged for this booking.",
    );
    expect(html).toContain("Would have been");
    expect(html).not.toContain(">Amount<");
    expect(html).not.toContain("Problem with this charge");
  });

  it("a cancelled gateway order keeps its Amount and the dispute door: a late capture can still land", async () => {
    const { html } = await page({
      paymentStatus: "EXPIRED",
      paymentIntent: "order_Nx81",
      amount: 161_444,
      originalAmount: 161_444,
    });
    expect(html).toContain(">Amount<");
    expect(html).not.toContain("Would have been");
    expect(html).toContain("Problem with this charge");
  });

  it("a lapsed hold that still holds referral credit keeps the dispute door", async () => {
    const { detail, html } = await page({
      paymentStatus: "EXPIRED",
      creditUsages: [{ amount: 20_000 }],
    });
    expect(detail.creditHeldPaise).toBe(20_000);
    expect(html).toContain("Problem with this charge");
  });

  it("a paid charge keeps its Amount and the dispute door", async () => {
    const { html } = await page({});
    expect(html).toContain(">Amount<");
    expect(html).toContain("Problem with this charge");
  });
});
