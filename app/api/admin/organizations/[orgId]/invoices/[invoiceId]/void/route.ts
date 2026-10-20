/**
 * POST /api/admin/organizations/[orgId]/invoices/[invoiceId]/void
 *
 * The platform voids an ISSUED/OVERDUE invoice: a credit note, the PO draw
 * returned, and REBILL (bookings return to the next rollup) or FORGIVE (the
 * receivable is written off). A paid invoice is refunded instead. ADMIN only
 * (`invoices.manage`), step-up, reason, one OpsActionLog row in the same tx.
 */

import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { voidOrgInvoice } from "@/lib/payments/billing/org-invoice-void";

export const POST = withOpsAction(
  "invoices.manage",
  "org-invoice.void",
  { mode: z.enum(["REBILL", "FORGIVE"]) },
  {
    mode: "tx",
    run: async (tx, { params, body, actor }) => {
      const voided = await voidOrgInvoice(tx, {
        organizationId: params.orgId,
        invoiceId: params.invoiceId,
        mode: body.mode,
        reason: body.reason,
        // The org's audit page renders this prefix as "Platform admin".
        actorMembershipId: `__admin_stub_${actor.userId}`,
      });
      return {
        target: { kind: "OrganizationInvoice", id: voided.invoiceId },
        after: {
          status: "VOID",
          mode: body.mode,
          creditNoteId: voided.creditNoteId,
          rebilledPaymentCount: voided.rebilledPaymentCount,
          receivableWrittenOffPaise: voided.receivableWrittenOffPaise,
          irnCorrectedByCreditNote: voided.irnCorrectedByCreditNote,
        },
        response: { voided },
      };
    },
  },
  { stepUp: true },
);
