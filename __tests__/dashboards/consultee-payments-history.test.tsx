/**
 * @jest-environment node
 */

/**
 * #1675 X5 — the consultee payment history renders one money line and one
 * badge per row from `derivePaymentPresentation`, never a raw enum. A paid
 * and a refunded row name their rail; a sponsored row shows the organisation
 * and no amount.
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaymentsHistoryList } from "@/app/dashboard/consultee/[consulteeId]/(features)/payments/PaymentsHistoryList";
import type {
  ConsulteePaymentRow,
  ConsulteePaymentRefund,
} from "@/lib/data/consultee-payments";

const AT = "2026-09-18T10:00:00Z";

function row(
  id: string,
  over: Partial<ConsulteePaymentRow> & {
    legs?: { source: string }[];
    refundRows?: Pick<ConsulteePaymentRefund, "amountPaise" | "status">[];
    sponsorOrgName?: string | null;
  } = {},
): ConsulteePaymentRow {
  const { legs, refundRows = [], sponsorOrgName = null, ...rest } = over;
  const status = rest.status ?? "SUCCEEDED";
  const refunds: ConsulteePaymentRefund[] = refundRows.map((r, i) => ({
    id: `${id}-r${i}`,
    reason: null,
    createdAt: AT,
    ...r,
  }));
  const paymentInput = {
    id,
    paymentStatus: status,
    paymentMethod: legs ? "WALLET" : "CARD",
    paymentGateway: "RAZORPAY",
    receiptUrl: "https://rzp.io/receipt/1",
    consumerInvoice: null,
    legs,
    refunds,
    amount: 150_000,
    currency: "INR",
    createdAt: AT,
    expiresAt: null,
  };
  return {
    id,
    amount: 150_000,
    originalAmount: 150_000,
    taxAmount: 0,
    currency: "INR",
    status,
    paymentMethod: paymentInput.paymentMethod,
    paymentGateway: "RAZORPAY",
    appointmentType: "CONSULTATION",
    appointmentId: `appt-${id}`,
    hasSupportThread: false,
    planTitle: `Plan ${id}`,
    consultantName: "Asha Rao",
    organizationId: null,
    discount: null,
    refunds,
    refundedPaise: 0,
    consumerInvoice: null,
    receiptUrl: paymentInput.receiptUrl,
    expiresAt: null,
    createdAt: AT,
    presentation: {
      appointmentType: "CONSULTATION",
      request: { status: "APPROVED", kind: "CONSULTATION", requestedAt: AT },
      payments: [paymentInput],
      refunds,
      disputes: [],
      childPayments: [],
      sponsorOrgName,
      holdExpiresAt: null,
      history: [],
      plan: { pricePaise: 150_000, currency: "INR", sessions: 1 },
      names: { payer: "you", consultant: "Asha Rao" },
    },
    ...rest,
  };
}

describe("PaymentsHistoryList", () => {
  const html = renderToStaticMarkup(
    <PaymentsHistoryList
      consulteeId="c-1"
      payments={[
        row("paid"),
        row("refunded", {
          refundRows: [{ amountPaise: 150_000, status: "SUCCEEDED" }],
        }),
        row("partly", {
          refundRows: [{ amountPaise: 50_000, status: "SUCCEEDED" }],
        }),
        row("sponsored", {
          legs: [{ source: "WALLET" }],
          sponsorOrgName: "Wipro Limited",
        }),
      ]}
    />,
  );
  const rowHtml = (id: string) =>
    html.split("<li").find((part) => part.includes(`Plan ${id}`)) ?? "";

  it("groups under a month header and links each row to its payment page", () => {
    expect(html).toContain("September 2026");
    // #1527 Q5 — the row opens the charge, not the booking.
    expect(html).toContain('href="/dashboard/consultee/c-1/payments/paid"');
  });

  it("paid and refunded rows carry the rail; sponsored carries the org and no amount", () => {
    expect(rowHtml("paid")).toContain("₹1,500.00 · Razorpay");
    expect(rowHtml("paid")).toContain("View receipt");
    expect(rowHtml("refunded")).toContain("₹1,500.00 refunded · Razorpay");
    expect(rowHtml("partly")).toContain("₹500.00 refunded · Razorpay");
    expect(rowHtml("sponsored")).toContain("Sponsored by Wipro Limited");
    expect(rowHtml("sponsored")).not.toContain("₹");
  });

  it("never shows a raw enum", () => {
    expect(html).not.toMatch(/\b(SUCCEEDED|REFUNDED|PENDING)\b/);
  });
});
