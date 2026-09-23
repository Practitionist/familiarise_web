/**
 * #771 / #749 — INVOICE accrual rollup.
 *
 * INVOICE_ACCRUAL PaymentLegs accrue per booking, but nothing rolled them into
 * an OrganizationInvoice (the "Generate invoice" button 404'd and manual create
 * orphaned the legs — so NET-30/60 orgs were never actually billed). This
 * gathers an org's unbilled accruals into one OrganizationInvoice with a line
 * per booking, computes GST, and stamps `Payment.billableToOrgInvoiceId` so the
 * next run can't double-bill.
 *
 * Reused by the cycle-close cron (`jobs/billing/settle-invoice-accruals.ts`)
 * and the "Generate invoice" action. The booking already debited ORG_RECEIVABLE
 * in the double-entry ledger at accrual time; the receivable clears when the
 * org pays the invoice (see `handleOrgPaymentSuccess`). Overage CHARGE_ORG
 * rollup is added once the overage writer lands (#715).
 */
import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { deriveGstBreakdown } from "@/lib/compliance/gst";
import { numericStateCode } from "@/lib/compliance/state-codes";
import { recordSystemError } from "@/lib/enterprise/system-events";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { notifyOrgInvoiceIssued } from "@/lib/novu/org-workflows";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu";
import { reportSentryError } from "@/lib/observability/report";
import { getAppUrl } from "@/lib/url";
import { generateOrgInvoiceNumber } from "./invoice-numbering";
import { supplierStateCode } from "./consumer-invoice";
import { transitionOverage } from "./overage-transitions";

export interface RollupResult {
  invoiceId: string | null;
  invoiceNumber: string | null;
  billedPaymentCount: number;
  subtotalPaise: number;
  totalPaise: number;
}

const EMPTY: RollupResult = {
  invoiceId: null,
  invoiceNumber: null,
  billedPaymentCount: 0,
  subtotalPaise: 0,
  totalPaise: 0,
};

/**
 * Roll an org's unbilled INVOICE_ACCRUAL bookings into one OrganizationInvoice.
 * Returns an empty result when there is nothing to bill.
 */
export async function rollupOrgInvoiceAccruals(params: {
  organizationId: string;
  issueImmediately?: boolean;
  billingCycleStart?: Date | null;
  billingCycleEnd?: Date | null;
}): Promise<RollupResult> {
  const { organizationId } = params;

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      deletedAt: true,
      invoiceNumberPrefix: true,
      billingAccountId: true,
      dataResidencyRegion: true,
      paymentTermsDays: true,
      taxInfo: {
        select: { gstStateCode: true, gstin: true, hsnDefault: true },
      },
    },
  });
  if (!org?.billingAccountId) return EMPTY;
  // #1744 row 6 — a wound-down org is never billed again; DELETE refuses while
  // an accrual is still unbilled, so anything left here is settled history.
  if (org.status === "DEACTIVATED" || org.deletedAt) return EMPTY;

  // #1447 — GSTIN-first supplier state; a mismatch throws before any tx opens.
  const supplierState = supplierStateCode();

  // #1357 7.4 — orphaned overage events are collected in the tx and written
  // AFTER it commits. `recordSystemError` goes through the global client, so a
  // call fired from inside the Serializable block races its own transaction:
  // a P2034 abort (routine here — retried below) would
  // leave a SystemEvent naming an invoice that was rolled back, and the cron's
  // `prisma.$disconnect()` can cut an un-awaited insert off mid-flight.
  const orphanedOverages: Array<{
    overageEventId: string;
    invoiceId: string;
    invoiceNumber: string;
    paymentId: string;
  }> = [];

  // #813 — Serializable + in-tx read: the accrued read, invoice create and
  // billableToOrgInvoiceId stamp must be one atomic unit, else two concurrent
  // runs both read the same unstamped set and each issue a duplicate invoice.
  // Under Serializable the loser aborts (P2034) or reads the empty set after
  // the winner stamps.
  //
  // #1347 — retried, not skipped. A P2034 from a same-org rival is harmless to
  // retry (the winner stamped billableToOrgInvoiceId, so the next attempt reads
  // the empty set and returns EMPTY), but Postgres also aborts on a read-write
  // dependency with an unrelated writer touching Payment/OverageEvent — and
  // skipping THAT left the org unbilled until the next monthly cycle with only
  // a console.log to show for it. Exhausted retries surface as P2034 to the
  // caller, which reports rather than swallows.
  const outcome = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // A retried attempt must not inherit the discarded one's orphans.
        orphanedOverages.length = 0;

        // Unbilled accrued bookings: org-tagged, succeeded payments carrying an
        // INVOICE_ACCRUAL leg not yet attached to an invoice.
        const accrued = await tx.payment.findMany({
          where: {
            organizationId,
            billableToOrgInvoiceId: null,
            paymentStatus: "SUCCEEDED",
            legs: {
              some: {
                source: { in: ["INVOICE_ACCRUAL", "OVERAGE_INVOICE_ACCRUAL"] },
              },
            },
          },
          select: {
            id: true,
            // Bill the base accrual AND any CHARGE_ORG overage (#715) on the
            // booking, NET of refund reversal legs (#786 — refunds append
            // negative *_REVERSAL siblings instead of mutating the original).
            legs: {
              where: {
                source: {
                  in: [
                    "INVOICE_ACCRUAL",
                    "OVERAGE_INVOICE_ACCRUAL",
                    "INVOICE_ACCRUAL_REVERSAL",
                    "OVERAGE_INVOICE_ACCRUAL_REVERSAL",
                  ],
                },
              },
              select: { amountPaise: true },
            },
          },
        });
        if (accrued.length === 0) return { result: EMPTY, notifyStaged: [] };

        const lines = accrued
          .map((p, i) => ({
            position: i,
            paymentId: p.id,
            description: `Sponsored session (booking ${p.id.slice(0, 8)})`,
            quantity: 1,
            unitPricePaise: p.legs.reduce((s, l) => s + l.amountPaise, 0),
          }))
          // A fully-refunded-before-billing booking nets to ≤0 — keep it out of
          // the issued document; the payment is still stamped below so it never
          // re-enters a future rollup.
          .filter((l) => l.unitPricePaise > 0)
          .map((l, i) => ({ ...l, position: i }));
        const subtotal = lines.reduce((s, l) => s + l.unitPricePaise, 0);
        if (subtotal <= 0) return { result: EMPTY, notifyStaged: [] };

        // #1744 row 3 — the buyer GSTIN's first two digits are the place of
        // supply; an org that never filled its state still gets the right head.
        const gst = deriveGstBreakdown({
          subtotalPaise: subtotal,
          supplierStateCode: supplierState,
          buyerStateCode:
            org.taxInfo?.gstStateCode ??
            numericStateCode(org.taxInfo?.gstin, null),
          buyerGstin: org.taxInfo?.gstin ?? null,
          buyerCountry: org.dataResidencyRegion === "IN" ? "IN" : "US",
          hsnCode: org.taxInfo?.hsnDefault,
        });

        // #776 — defensive invariant at issue time: the subtotal must equal the
        // line-item sum and the GST breakdown must net exactly (total == subtotal +
        // CGST + SGST + IGST). A mis-totaled GST invoice is a filing defect, so hard-throw
        // here rather than persist it (catches any future rounding regression upstream).
        const taxParts = gst.igstPaise + gst.cgstPaise + gst.sgstPaise;
        if (
          gst.subtotalPaise !== subtotal ||
          gst.totalPaise !== gst.subtotalPaise + taxParts
        ) {
          throw new Error(
            `Invoice total mismatch for org ${organizationId}: subtotal=${gst.subtotalPaise} (lineItems=${subtotal}) tax=${taxParts} total=${gst.totalPaise}`,
          );
        }

        const issuedAt = new Date();
        const issueImmediately = params.issueImmediately ?? true;
        const dueDate = new Date(issuedAt);
        dueDate.setDate(dueDate.getDate() + (org.paymentTermsDays ?? 60));

        const { invoiceNumber, fiscalYear } = await generateOrgInvoiceNumber(
          tx,
          {
            id: org.id,
            slug: org.slug,
            invoiceNumberPrefix: org.invoiceNumberPrefix,
          },
          issuedAt,
        );

        const invoice = await tx.organizationInvoice.create({
          data: {
            billingAccountId: org.billingAccountId!,
            organizationId,
            invoiceNumber,
            fiscalYear,
            status: issueImmediately ? "ISSUED" : "DRAFT",
            displayCurrency: "INR",
            inrEquivalentPaise: gst.totalPaise,
            subtotalPaise: gst.subtotalPaise,
            igstPaise: gst.igstPaise,
            cgstPaise: gst.cgstPaise,
            sgstPaise: gst.sgstPaise,
            totalPaise: gst.totalPaise,
            taxRate:
              gst.igstPaise + gst.cgstPaise + gst.sgstPaise > 0 ? 0.18 : 0,
            hsnCode: gst.hsnCode,
            placeOfSupply: gst.placeOfSupply,
            reverseCharge: gst.reverseCharge,
            gstin: org.taxInfo?.gstin ?? null,
            irpStatus: "PENDING",
            autoGenerated: true,
            issuedAt: issueImmediately ? issuedAt : null,
            dueDate,
            billingCycleStart: params.billingCycleStart ?? null,
            billingCycleEnd: params.billingCycleEnd ?? null,
            lineItems: {
              create: lines.map((l) => ({
                position: l.position,
                description: l.description,
                quantity: l.quantity,
                unitPricePaise: l.unitPricePaise,
                paymentId: l.paymentId,
                hsnCode: gst.hsnCode,
              })),
            },
          },
        });

        // Stamp the accrued payments. The `billableToOrgInvoiceId: null` guard is the
        // secondary defence; #813 Serializable above is what stops two runs both
        // issuing — a concurrent run a no-op for already-claimed payments.
        await tx.payment.updateMany({
          where: {
            id: { in: accrued.map((p) => p.id) },
            billableToOrgInvoiceId: null,
          },
          data: { billableToOrgInvoiceId: invoice.id },
        });

        // #771 / #715 — mark CHARGE_ORG overage events for these bookings settled so
        // the next run can't re-bill them. Their marginal is already in the line
        // amounts via the OVERAGE_INVOICE_ACCRUAL legs summed above.
        //
        // #768 #14/#15 — also stamp invoiceLineItemId so each event points at the
        // exact InvoiceLineItem it rolled into (auditability + reversal). updateMany
        // can't set per-row distinct values, so we map paymentId → lineItemId from
        // the line items we just created (one line per payment) and update per event.
        const createdLineItems = await tx.invoiceLineItem.findMany({
          where: { invoiceId: invoice.id, paymentId: { not: null } },
          select: { id: true, paymentId: true },
        });
        const lineItemByPaymentId = new Map(
          createdLineItems.map((li) => [li.paymentId!, li.id]),
        );

        const overageEvents = await tx.overageEvent.findMany({
          where: {
            overageBehavior: "CHARGE_ORG",
            // #1744 row 6 — only PENDING events can move to ACCRUED; a
            // REVERSED/FAILED one is not an orphan, it is already settled.
            chargeStatus: "PENDING",
            settledAt: null,
            bookingUtilization: { paymentId: { in: accrued.map((p) => p.id) } },
          },
          select: {
            id: true,
            bookingUtilization: { select: { paymentId: true } },
          },
        });

        const settledAt = new Date();
        for (const ev of overageEvents) {
          // #775 — PENDING → ACCRUED: now on an issued invoice. The invoice-paid
          // ledger handler flips ACCRUED → CHARGED on payment.
          const moved = await transitionOverage(tx, { id: ev.id }, "ACCRUED", {
            settledAt,
            invoiceLineItemId:
              lineItemByPaymentId.get(ev.bookingUtilization.paymentId) ?? null,
          });

          // #1357 7.4 (inverse) — the allowed-from guard IS the filter, so an
          // event that is no longer PENDING silently does not move and the
          // discarded count was the only evidence. The payment carries
          // billableToOrgInvoiceId from the stamp above and the next rollup reads
          // only unstamped payments, so nothing gets re-billed; what is lost is
          // the event's own settlement — it never links to the line item that
          // billed it and never reaches CHARGED when the invoice is paid. The
          // invoice still commits — the money is on it and refusing to issue would
          // strand the whole cycle — but the orphan is recorded for a human.
          if (moved === 0) {
            orphanedOverages.push({
              overageEventId: ev.id,
              invoiceId: invoice.id,
              invoiceNumber,
              paymentId: ev.bookingUtilization.paymentId,
            });
          }
        }

        // #1744 row 2 — an ISSUED rollup invoice tells the owners and the
        // integrators, like the subscription cron does. Both are staged on
        // this tx (#1669 outbox): a rollback takes them too, and one row per
        // invoice is guaranteed by the billableToOrgInvoiceId stamp above.
        let notifyStaged: StagedTrigger[] = [];
        if (issueImmediately) {
          const origin = getAppUrl();
          notifyStaged = await notifyOrgInvoiceIssued(
            organizationId,
            {
              invoiceNumber,
              orgName: org.name,
              totalPaise: gst.totalPaise,
              currency: "INR",
              dueDate: dueDate.toISOString(),
              dashboardUrl: `${origin}/dashboard/organization/${organizationId}/billing`,
              pdfUrl: `${origin}/api/organizations/${organizationId}/billing-account/invoices/${invoice.id}/pdf`,
            },
            { tx, entityRef: `orgInvoice:${invoice.id}` },
          );
          await dispatchWebhookEvent({
            prisma: tx,
            organizationId,
            eventType: "invoice.issued",
            payload: {
              invoiceId: invoice.id,
              invoiceNumber,
              totalPaise: gst.totalPaise,
              displayCurrency: "INR",
              dueDate: dueDate.toISOString(),
              purchaseOrderId: null,
              contractId: null,
            },
          });
        }

        return {
          result: {
            invoiceId: invoice.id,
            invoiceNumber,
            billedPaymentCount: accrued.length,
            subtotalPaise: gst.subtotalPaise,
            totalPaise: gst.totalPaise,
          },
          notifyStaged,
        };
      },
      { isolationLevel: "Serializable", maxWait: 10_000, timeout: 15_000 },
    ),
  );
  const { result, notifyStaged } = outcome;

  // #1744 row 2 — the post-commit attempt; `attemptTrigger` never throws, the
  // guard only protects the loop so a bell failure cannot hide a committed invoice.
  try {
    for (const row of notifyStaged) await attemptTrigger(row);
  } catch (e) {
    reportSentryError(e, { subsystem: "payments" });
    console.error("[invoice-rollup] invoice-issued notify attempt failed:", e);
  }

  // Awaited, not voided: the caller is a cron that disconnects Prisma as soon
  // as it returns, and these rows are the only record that an event was left
  // behind. `recordSystemError` is best-effort internally, so allSettled here
  // is belt-and-braces — one failed insert must not lose the others or throw
  // away an invoice that has already committed.
  if (orphanedOverages.length > 0) {
    const written = await Promise.allSettled(
      orphanedOverages.map((o) =>
        recordSystemError({
          organizationId,
          category: "OVERAGE",
          summary: `OverageEvent ${o.overageEventId} did not move to ACCRUED while rolling up invoice ${o.invoiceNumber} — its marginal is billed on that invoice but the event keeps its previous chargeStatus, so it never links to the line item and never reaches CHARGED when the invoice is paid`,
          err: new Error("OVERAGE_ACCRUAL_TRANSITION_NOOP"),
          context: o,
        }),
      ),
    );
    for (const w of written) {
      if (w.status === "rejected") {
        console.error(
          "[invoice-rollup] orphaned-overage SystemEvent write failed:",
          w.reason,
        );
      }
    }
  }

  return result;
}
