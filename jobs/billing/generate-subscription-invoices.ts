/**
 * Cron: generate BillingSubscription-driven invoices — REAL (Issue #681).
 *
 * Schedule: the ticker's daily window from 03:00 UTC, in `limit`-sized slices.
 * Scope: every `BillingSubscription` with `nextInvoiceDate <= windowStart`
 * (or now for a manual run), so a later slice never bills a newly due cycle.
 *
 * Concurrency:
 *   Each due subscription is handled inside a Serializable `$transaction`.
 *   The claim step is a conditional `updateMany` that only advances
 *   `nextInvoiceDate` if it's still `<= now` — this doubles as the
 *   distributed lock: two cron replicas (or a retried invocation) race
 *   on the UPDATE, exactly one wins, the loser's `claimed.count === 0`
 *   and it silently skips. All three side-effects
 *   (invoice create + cycle advance + issue journal) commit
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
 *
 * IRP upload is handled by the separate `irp-uploader.ts` cron.
 */

import prisma from "@/lib/prisma";
import { deriveGstBreakdown } from "@/lib/compliance/gst";
import { generateOrgInvoiceNumber } from "@/lib/payments/billing/invoice-numbering";
import { postInvoiceIssuedJournal } from "@/lib/payments/billing/org-invoice-journal";
import { notifyIssuedOrgInvoice } from "@/lib/payments/billing/create-org-invoice";
import { drawCoveringPurchaseOrder } from "@/lib/payments/billing/purchase-order-draw";
import { supplierStateCode } from "@/lib/payments/billing/consumer-invoice";
import {
  GST_UNREGISTERED_SKIP,
  reportConfigSkip,
} from "@/lib/cron/config-skip";
import { platformSupplierForJob } from "@/lib/pdf/supplier";
import { BILLABLE_ORG_STATUSES } from "@/lib/enterprise/org-status";
import { notifyOrgLicenseRenewalUpcoming } from "@/lib/novu/org-workflows";
import { sendOrgOperationalEmail } from "@/lib/email/senders/money";
import { getAppUrl } from "@/lib/url";
import { Currency, OrgInvoiceStatus, Prisma } from "@prisma/client";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import {
  createRunFailureReporter,
  type RunFailureReporter,
} from "@/lib/observability/run-failures";
import { recordSystemEventSafe } from "@/lib/enterprise/system-events";
import { nextPeriodEnd } from "@/lib/enterprise/cycle-engine";

// Reminder fires when nextInvoiceDate is within this many days. Once
// per cycle (gated by BillingSubscription.renewalReminderSentAt).
const RENEWAL_REMINDER_WINDOW_DAYS = 7;

/** Subscriptions due by `asOf` on a billable org's ACTIVE, in-term contract. */
function dueSubscriptionWhere(
  asOf: Date,
  now: Date,
): Prisma.BillingSubscriptionWhereInput {
  return {
    nextInvoiceDate: { lte: asOf },
    contract: {
      organization: { status: { in: BILLABLE_ORG_STATUSES } },
      status: "ACTIVE",
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
  };
}

/** Unreminded subscriptions renewing within the reminder window after `now`. */
function renewalReminderWhere(now: Date): Prisma.BillingSubscriptionWhereInput {
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + RENEWAL_REMINDER_WINDOW_DAYS);
  return {
    renewalReminderSentAt: null,
    nextInvoiceDate: { gt: now, lte: horizon },
    contract: {
      organization: { status: { in: BILLABLE_ORG_STATUSES } },
    },
  };
}

export interface GenerateSubscriptionInvoicesResult {
  generated: number;
  skipped: number;
  failed: number;
  remindersSent: number;
  remaining: number;
}

/** `limit` caps the invoice claims attempted and, separately, the reminders sent. */
export async function runGenerateSubscriptionInvoices(opts: {
  limit?: number;
  windowStart?: Date;
}): Promise<GenerateSubscriptionInvoicesResult> {
  return withCronLock(
    "generate-subscription-invoices",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => generateSubscriptionInvoices(opts),
  );
}

async function generateSubscriptionInvoices(opts: {
  limit?: number;
  windowStart?: Date;
}): Promise<GenerateSubscriptionInvoicesResult> {
  const failures = createRunFailureReporter("jobs");
  const now = new Date();
  const asOf = opts.windowStart ?? now;
  const remindersSent = await sendRenewalReminders(now, opts.limit);

  const dueSubs = await prisma.billingSubscription.findMany({
    where: dueSubscriptionWhere(asOf, now),
    include: {
      contract: {
        include: {
          organization: {
            select: {
              id: true,
              name: true,
              slug: true,
              invoiceNumberPrefix: true,
              requiresPO: true,
              taxInfo: { select: { gstStateCode: true, gstin: true } },
            },
          },
        },
      },
      billingAccount: true,
    },
    orderBy: { nextInvoiceDate: "asc" },
  });

  let generated = 0;
  let skipped = 0;
  const heldForPo: { organizationId: string; invoiceNumber: string }[] = [];
  let failed = 0;
  let attempted = 0;
  let visited = 0;

  // No GST invoice while unregistered; a malformed or wrong-state GSTIN throws
  // here so no invoice in the run is issued under an ambiguous state.
  if (!platformSupplierForJob()) {
    reportConfigSkip("generate-subscription-invoices", GST_UNREGISTERED_SKIP);
    return {
      generated: 0,
      skipped: 0,
      failed: 0,
      remindersSent,
      remaining: dueSubs.length,
    };
  }
  const supplierState = supplierStateCode();

  for (const sub of dueSubs) {
    if (opts.limit !== undefined && attempted >= opts.limit) break;
    visited += 1;
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
      supplierStateCode: supplierState,
      buyerStateCode: sub.contract.organization.taxInfo?.gstStateCode ?? null,
      buyerCountry: "IN",
    });

    const dueDate = new Date(now);
    dueDate.setDate(dueDate.getDate() + sub.contract.paymentTermsDays);

    // Advance cycle once — compute outside the tx for a stable target.
    const nextStart = sub.currentCycleEnd;
    const nextEnd = nextPeriodEnd(nextStart, sub.cycle);

    // #1401 — held outside the transaction so the P2002 handler below can name
    // the number that collided; the value is only meaningful once the claim has
    // been won and the counter reserved.
    let competingInvoiceNumber: string | undefined;

    attempted += 1;
    try {
      const result = await prisma.$transaction(
        async (tx) => {
          // Claim: advance nextInvoiceDate atomically. Only one worker
          // can win this UPDATE because we gate on the pre-update value.
          const claimed = await tx.billingSubscription.updateMany({
            where: {
              id: sub.id,
              nextInvoiceDate: { lte: asOf },
              // Re-checked AT CLAIM TIME: the contract may have terminated
              // (or its term ended) between the cohort read and this write.
              contract: {
                status: "ACTIVE",
                OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
              },
            },
            data: {
              currentCycleStart: nextStart,
              currentCycleEnd: nextEnd,
              nextInvoiceDate: nextEnd,
              // New cycle, new reminder window — clear the gate so
              // the upcoming-renewal Novu fires once before nextEnd.
              renewalReminderSentAt: null,
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
              invoiceNumberPrefix:
                sub.contract.organization.invoiceNumberPrefix,
            },
            now,
          );
          competingInvoiceNumber = invoiceNumber;

          // An org that requires a PO gets a DRAFT for an admin to issue with one.
          const purchaseOrderId = sub.contract.organization.requiresPO
            ? await drawCoveringPurchaseOrder(tx, {
                organizationId: sub.contract.organization.id,
                currency: Currency.INR,
                amountPaise: gst.totalPaise,
                now,
              })
            : null;
          const issue =
            !sub.contract.organization.requiresPO || purchaseOrderId !== null;

          const invoice = await tx.organizationInvoice.create({
            data: {
              billingAccountId: sub.billingAccountId,
              organizationId: sub.contract.organization.id,
              purchaseOrderId,
              invoiceNumber,
              fiscalYear,
              status: issue ? OrgInvoiceStatus.ISSUED : OrgInvoiceStatus.DRAFT,
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
              gstin: sub.contract.organization.taxInfo?.gstin ?? null,
              lineItems: {
                create: [
                  {
                    position: 0,
                    description:
                      sub.model === "FLAT_FEE"
                        ? "Enterprise license flat fee"
                        : `Per-seat license × ${sub.activeSeatCount} seats`,
                    quantity:
                      sub.model === "PER_SEAT" ? sub.activeSeatCount : 1,
                    unitPricePaise:
                      sub.model === "FLAT_FEE"
                        ? (sub.flatFeePaise ?? 0)
                        : (sub.ratePerSeatPaise ?? 0),
                  },
                ],
              },
              issuedAt: issue ? now : null,
              dueDate,
              billingCycleStart: sub.currentCycleStart,
              billingCycleEnd: sub.currentCycleEnd,
              autoGenerated: true,
            },
          });
          if (!issue) {
            return {
              claimed: true as const,
              issued: false as const,
              invoiceId: invoice.id,
              invoiceNumber,
              totalPaise: gst.totalPaise,
            };
          }
          // A licence fee is billed once, so its GST is booked here and nowhere else.
          await postInvoiceIssuedJournal(tx, invoice.id);

          await dispatchWebhookEvent({
            prisma: tx,
            organizationId: sub.contract.organization.id,
            eventType: "invoice.issued",
            payload: {
              invoiceId: invoice.id,
              invoiceNumber,
              totalPaise: gst.totalPaise,
              displayCurrency: Currency.INR,
              dueDate: dueDate.toISOString(),
              purchaseOrderId,
              contractId: sub.contract.id,
            },
          });

          return {
            claimed: true as const,
            issued: true as const,
            invoiceId: invoice.id,
            invoiceNumber,
            totalPaise: gst.totalPaise,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );

      if (result.claimed && !result.issued) {
        generated++;
        heldForPo.push({
          organizationId: sub.contract.organization.id,
          invoiceNumber: result.invoiceNumber,
        });
      } else if (result.claimed) {
        generated++;
        await notifyIssuedOrgInvoice(
          getAppUrl(),
          sub.contract.organization.id,
          {
            invoiceId: result.invoiceId,
            invoiceNumber: result.invoiceNumber,
            totalPaise: result.totalPaise,
            currency: Currency.INR,
            dueDate,
            orgName: sub.contract.organization.name,
          },
        );
      } else {
        console.log(
          `[cron] Subscription ${sub.id} already claimed by another worker, skipping`,
        );
        skipped++;
      }
    } catch (err) {
      failed++;
      await reportSubscriptionFailure(
        failures,
        sub,
        err,
        competingInvoiceNumber,
      );
    }
  }

  // One row per run; ops issues each DRAFT with a PO from the admin console.
  if (heldForPo.length > 0) {
    await recordSystemEventSafe({
      category: "INVOICE",
      severity: "WARN",
      message: `SUBSCRIPTION_PO_NOT_COVERED: ${heldForPo.length} subscription invoice(s) held as DRAFT because no active purchase order covers them`,
      context: { invoices: heldForPo.slice(0, 50) },
    });
  }

  failures.flush();
  console.log(
    `[cron] generate-subscription-invoices: ${generated} invoices, ${skipped} skipped, ${failed} failed, ${remindersSent} renewal reminders`,
  );
  return {
    generated,
    skipped,
    failed,
    remindersSent,
    remaining: dueSubs.length - visited,
  };
}

/**
 * Unique-number collision (two parallel workers computed the same invoiceNumber
 * while their claim-UPDATE was still in flight) is the one failure worth an
 * alert of its own; the cron is idempotent on its next run.
 */
async function reportSubscriptionFailure(
  failures: RunFailureReporter,
  sub: { id: string; contract: { organization: { id: string } } },
  err: unknown,
  competingInvoiceNumber: string | undefined,
): Promise<void> {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  ) {
    console.warn(
      `[cron] Duplicate invoiceNumber for subscription ${sub.id}; will retry next run`,
    );
    // #1401 — no number burns: the counter reservation runs inside the same
    // Serializable transaction, so the collision rolls the sequence back with
    // it. A repeating collision means the claim UPDATE stopped serialising the
    // workers, which is worth waking someone for.
    failures.add(
      "generate-subscription-invoices.duplicate-number",
      err,
      { subscriptionId: sub.id, competingInvoiceNumber },
      { level: "error" },
    );
    // One capture, not two: the durable row goes through recordSystemEvent,
    // awaited so `$disconnect()` at the end of `main` cannot lose it.
    await recordSystemEventSafe({
      organizationId: sub.contract.organization.id,
      category: "INVOICE",
      severity: "ERROR",
      message: `Duplicate invoice number on subscription ${sub.id}: ${err.message}`,
      context: {
        subscriptionId: sub.id,
        competingInvoiceNumber,
        errorMessage: err.message,
      },
    });
    return;
  }
  failures.add("generate-subscription-invoices", err, {
    subscriptionId: sub.id,
  });
  console.error(
    `[cron] Failed to generate invoice for subscription ${sub.id}:`,
    err,
  );
}

async function sendRenewalReminders(
  now: Date,
  limit: number | undefined,
): Promise<number> {
  const due = await prisma.billingSubscription.findMany({
    where: renewalReminderWhere(now),
    include: {
      contract: {
        include: {
          organization: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { nextInvoiceDate: "asc" },
    take: limit,
  });

  let sent = 0;
  for (const sub of due) {
    const expectedTotalPaise =
      sub.model === "FLAT_FEE"
        ? (sub.flatFeePaise ?? 0)
        : (sub.ratePerSeatPaise ?? 0) * sub.activeSeatCount;

    const daysUntilRenewal = Math.max(
      0,
      Math.ceil(
        (sub.nextInvoiceDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
      ),
    );

    // Claim first so a crashed Novu trigger doesn't double-fire on the
    // next cron tick. Conditional update gates on the still-null
    // value, mirroring the invoice claim pattern below.
    const claimed = await prisma.billingSubscription.updateMany({
      where: { id: sub.id, renewalReminderSentAt: null },
      data: { renewalReminderSentAt: now },
    });
    if (claimed.count === 0) continue;

    try {
      const orgId = sub.contract.organization.id;
      const dashboardUrl = `${getAppUrl()}/dashboard/organization/${orgId}/billing`;
      const ownerRows = prisma.membership?.findMany
        ? await prisma.membership.findMany({
            where: {
              organizationId: orgId,
              status: "ACTIVE",
              role: "OWNER",
            },
            select: { userId: true },
          })
        : [];
      await Promise.all([
        Promise.resolve(
          notifyOrgLicenseRenewalUpcoming(orgId, {
            orgName: sub.contract.organization.name,
            cycle: sub.cycle,
            renewalDate: sub.nextInvoiceDate.toISOString(),
            daysUntilRenewal,
            expectedTotalPaise,
            currency: "INR",
            dashboardUrl,
          }),
        ).catch((err) => {
          console.error("[cron] notifyOrgLicenseRenewalUpcoming failed:", err);
          return [];
        }),
        Promise.resolve(
          sendOrgOperationalEmail({
            recipientUserIds: ownerRows.map((r) => r.userId),
            organizationId: orgId,
            orgName: sub.contract.organization.name,
            kind: "LICENSE_RENEWAL_UPCOMING",
            expectedTotalPaise,
            currency: "INR",
            renewalDate: sub.nextInvoiceDate,
            daysUntilRenewal,
            cycle: sub.cycle,
            actionUrl: dashboardUrl,
          }),
        ).catch((err) => {
          console.error("[cron] sendOrgOperationalEmail failed:", err);
        }),
      ]);
      sent++;
    } catch (err) {
      // Novu non-throwing already, but belt-and-braces — the claim
      // already committed so re-running won't double-send.
      console.error(
        `[cron] renewal-upcoming notify failed for sub ${sub.id}:`,
        err,
      );
    }
  }
  return sent;
}
