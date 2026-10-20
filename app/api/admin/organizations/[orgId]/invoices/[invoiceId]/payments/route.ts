/**
 * POST /api/admin/organizations/[orgId]/invoices/[invoiceId]/payments
 *
 * The platform records a bank transfer (UTR) against an ISSUED/OVERDUE
 * invoice. Part-payments are allowed; the receipt that clears the outstanding
 * amount settles the invoice through the same transition as a gateway capture.
 * ADMIN only (`invoices.manage`), step-up, reason, one OpsActionLog row in the tx.
 */

import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import {
  attemptSettledInvoiceNotices,
  recordBankTransferReceipt,
} from "@/lib/payments/billing/org-invoice-settlement";

export const POST = withOpsAction(
  "invoices.manage",
  "org-invoice.record-bank-transfer",
  {
    utr: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{6,32}$/, "A UTR is 6 to 32 letters or digits."),
    // ₹10 crore per transfer.
    amountPaise: z.number().int().positive().max(1_000_000_000),
    receivedOn: z.coerce
      .date()
      .refine(
        (d) => d.getTime() <= Date.now(),
        "A receipt cannot be dated in the future.",
      ),
  },
  {
    mode: "tx",
    run: async (tx, { params, body, actor }) => {
      const recorded = await recordBankTransferReceipt(tx, {
        organizationId: params.orgId,
        invoiceId: params.invoiceId,
        utr: body.utr.toUpperCase(),
        amountPaise: body.amountPaise,
        receivedOn: body.receivedOn,
        recordedById: actor.userId,
        actorMembershipId: `__admin_stub_${actor.userId}`,
      });
      const { settled } = recorded;
      return {
        target: { kind: "OrganizationInvoiceReceipt", id: recorded.receiptId },
        after: {
          invoiceId: params.invoiceId,
          utr: body.utr.toUpperCase(),
          amountPaise: recorded.amountPaise,
          outstandingAfterPaise: recorded.outstandingAfterPaise,
          invoicePaid: settled !== null,
        },
        response: {
          receiptId: recorded.receiptId,
          outstandingPaise: recorded.outstandingAfterPaise,
          invoicePaid: settled !== null,
        },
        status: 201,
        afterCommit: settled
          ? () => attemptSettledInvoiceNotices(settled)
          : undefined,
      };
    },
  },
  {
    stepUp: true,
    secondApprover: {
      route: "/api/admin/organizations/[orgId]/invoices/[invoiceId]/payments",
      target: ({ params }) => ({
        kind: "OrganizationInvoice",
        id: params.invoiceId,
      }),
      amountPaise: (body) => body.amountPaise,
    },
  },
);
