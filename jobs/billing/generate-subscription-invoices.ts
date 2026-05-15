/**
 * Cron: generate BillingSubscription-driven invoices — REAL (Issue #681).
 *
 * Schedule: daily at 01:00 IST.
 * Scope: every `BillingSubscription` with `nextInvoiceDate <= now`.
 *
 * Concurrency:
 *   Each due subscription is handled inside a Serializable `$transaction`.
 *   The claim step is a conditional `updateMany` that only advances
 *   `nextInvoiceDate` if it's still `<= now` — this doubles as the
 *   distributed lock: two cron replicas (or a retried invocation) race
 *   on the UPDATE, exactly one wins, the loser's `claimed.count === 0`
 *   and it silently skips. All three side-effects
 *   (invoice create + cycle advance + settlement ledger) commit
 *   together so a crash mid-way cannot produce a duplicate invoice on
 *   the next run.
 *
 * For each due subscription:
 *   1. Compute the invoice amount (flatFeePaise for FLAT_FEE, or
 *      activeSeatCount × ratePerSeatPaise for PER_SEAT).
 *   2. Atomically claim the subscription by advancing `nextInvoiceDate`
 *      from `<= now` to the next cycle end.
 *   3. Create an OrganizationInvoice with GST breakdown (stubbed via
 *      lib/compliance/gst.ts).
 *   4. Emit a SettlementLedgerEntry (kind=INVOICE_ISSUED).
 *
 * IRP upload is handled by the separate `irp-uploader.ts` cron.
 */

import prisma from "@/lib/prisma";
import { deriveGstBreakdown } from "@/lib/compliance/gst";
import { generateOrgInvoiceNumber } from "@/lib/payments/billing/invoice-numbering";
import { BILLABLE_ORG_STATUSES } from "@/lib/enterprise/org-status";
import { Currency, OrgInvoiceStatus, Prisma } from "@prisma/client";

export async function runGenerateSubscriptionInvoices(): Promise<{
  generated: number;
  skipped: number;
}> {
  const now = new Date();

  const dueSubs = await prisma.billingSubscription.findMany({
    where: {
      nextInvoiceDate: { lte: now },
      contract: {
        organization: { status: { in: BILLABLE_ORG_STATUSES } },
      },
    },
    include: {
      contract: {
        include: {
          organization: {
            select: {
              id: true,
              slug: true,
              gstStateCode: true,
              gstin: true,
              invoiceNumberPrefix: true,
            },
          },
        },
      },
      billingAccount: true,
    },
  });

  let generated = 0;
  let skipped = 0;

  for (const sub of dueSubs) {
    const subtotal =
      sub.model === "FLAT_FEE"
        ? (sub.flatFeePaise ?? 0)
        : (sub.ratePerSeatPaise ?? 0) * sub.activeSeatCount;
    if (subtotal <= 0) {
      console.warn(
        `[cron] Skipping subscription ${sub.id} with non-positive subtotal`,
      );
      skipped++;
      continue;
    }

    const gst = deriveGstBreakdown({
      subtotalPaise: subtotal,
      // Supplier state defaults to Karnataka but is env-overridable so a
      // change of business address (or a regional GSTIN) doesn't require
      // a code change. Place-of-supply rules use this to decide CGST+SGST
      // vs IGST split.
      supplierStateCode: process.env.SUPPLIER_STATE_CODE ?? "KA",
      buyerStateCode: sub.contract.organization.gstStateCode,
      buyerCountry: "IN",
    });

    const dueDate = new Date(now);
    dueDate.setDate(dueDate.getDate() + sub.contract.paymentTermsDays);

    // Advance cycle once — compute outside the tx for a stable target.
    const nextStart = sub.currentCycleEnd;
    const nextEnd = new Date(nextStart);
    if (sub.cycle === "MONTHLY") nextEnd.setMonth(nextEnd.getMonth() + 1);
    else if (sub.cycle === "QUARTERLY")
      nextEnd.setMonth(nextEnd.getMonth() + 3);
    else nextEnd.setFullYear(nextEnd.getFullYear() + 1);

    try {
      const result = await prisma.$transaction(
        async (tx) => {
          // Claim: advance nextInvoiceDate atomically. Only one worker
          // can win this UPDATE because we gate on the pre-update value.
          const claimed = await tx.billingSubscription.updateMany({
            where: {
              id: sub.id,
              nextInvoiceDate: { lte: now },
            },
            data: {
              currentCycleStart: nextStart,
              currentCycleEnd: nextEnd,
              nextInvoiceDate: nextEnd,
            },
          });
          if (claimed.count === 0) {
            return { claimed: false as const };
          }

          // Per-org sequential number — atomic counter reservation.
          const { invoiceNumber, fiscalYear } = await generateOrgInvoiceNumber(
            tx,
            {
              id: sub.contract.organization.id,
              slug: sub.contract.organization.slug,
              invoiceNumberPrefix: sub.contract.organization.invoiceNumberPrefix,
            },
            now,
          );

          const invoice = await tx.organizationInvoice.create({
            data: {
              billingAccountId: sub.billingAccountId,
              organizationId: sub.contract.organization.id,
              invoiceNumber,
              fiscalYear,
              status: OrgInvoiceStatus.ISSUED,
              displayCurrency: Currency.INR,
              inrEquivalentPaise: gst.totalPaise,
              subtotalPaise: gst.subtotalPaise,
              igstPaise: gst.igstPaise,
              cgstPaise: gst.cgstPaise,
              sgstPaise: gst.sgstPaise,
              totalPaise: gst.totalPaise,
              hsnCode: gst.hsnCode,
              placeOfSupply: gst.placeOfSupply,
              reverseCharge: gst.reverseCharge,
              gstin: sub.contract.organization.gstin,
              items: [
                {
                  description:
                    sub.model === "FLAT_FEE"
                      ? "Enterprise license flat fee"
                      : `Per-seat license × ${sub.activeSeatCount} seats`,
                  quantity:
                    sub.model === "PER_SEAT" ? sub.activeSeatCount : 1,
                  unitPrice:
                    sub.model === "FLAT_FEE"
                      ? (sub.flatFeePaise ?? 0)
                      : (sub.ratePerSeatPaise ?? 0),
                },
              ],
              issuedAt: now,
              dueDate,
              billingCycleStart: sub.currentCycleStart,
              billingCycleEnd: sub.currentCycleEnd,
              autoGenerated: true,
            },
          });

          await tx.settlementLedgerEntry.create({
            data: {
              organizationId: sub.contract.organization.id,
              invoiceId: invoice.id,
              kind: "INVOICE_ISSUED",
              amountPaise: invoice.totalPaise,
              currency: Currency.INR,
            },
          });

          return { claimed: true as const, invoiceId: invoice.id };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );

      if (result.claimed) {
        generated++;
      } else {
        console.log(
          `[cron] Subscription ${sub.id} already claimed by another worker, skipping`,
        );
        skipped++;
      }
    } catch (err) {
      // Unique-number collision (two parallel workers computed the same
      // invoiceNumber while their claim-UPDATE was still in flight) is
      // the one other failure mode worth handling gracefully. The cron
      // is idempotent on its next run.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        console.warn(
          `[cron] Duplicate invoiceNumber for subscription ${sub.id}; will retry next run`,
        );
        skipped++;
        continue;
      }
      console.error(
        `[cron] Failed to generate invoice for subscription ${sub.id}:`,
        err,
      );
      skipped++;
    }
  }

  console.log(
    `[cron] generate-subscription-invoices: ${generated} invoices created, ${skipped} skipped`,
  );
  return { generated, skipped };
}
