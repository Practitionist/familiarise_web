/**
 * Consolidated Invoice Rollup — Core Logic (flag-gated)
 *
 * For parent orgs with child orgs (schema hierarchy: `Organization.parentId`
 * + `.rootId` + `.depth`), rolls up each child's outstanding ISSUED
 * `OrganizationInvoice` rows into a single parent invoice. This matches
 * the "one Wipro bill per month, broken down by BU" pattern that enterprise
 * finance teams expect.
 *
 * Gated on `ENABLE_CONSOLIDATED_INVOICE` because the org hierarchy is
 * schema-only for most tenants today — turning this on without a parent
 * org that actually has children is a safe no-op, but turning it on for
 * a tenant whose finance team isn't expecting a rollup would be
 * surprising. Default OFF.
 *
 * Conservative invariants (v1):
 *   - Only parent orgs with `canSponsor = true` are considered.
 *   - Only child invoices in status ISSUED are rolled up (DRAFT / PAID /
 *     VOID / CANCELLED / OVERDUE / REFUNDED are excluded — ISSUED is the
 *     "outstanding, awaiting payment" state).
 *   - Child currency must match parent `reportingCurrency`. Mixed-currency
 *     subtrees emit a warning and are skipped until FX rules land.
 *   - Children's invoices are NOT mutated. If the parent's rollup payment
 *     fails later, the child invoices are still individually payable. A
 *     follow-up VOID-on-settlement step is tracked in the Phase 2 epic.
 *   - Tax breakdown on the rollup is zero (intra-org transfer). CA review
 *     is pending — the production rollout should confirm whether IGST /
 *     CGST / SGST on a parent-child transfer is applicable. Tracked in
 *     the Phase 2 epic.
 *
 * Schedule: monthly, 09:30 IST (04:00 UTC) on day-1
 *           (GH Actions: `0 4 1 * *`). Offsets from the 07:30, 08:00,
 *           and 08:30 IST daily crons by being the first day-1-only
 *           job of the morning window.
 *
 * This module exports the core rollup function. It is imported by:
 *   - jobs/cleanup/consolidated-invoice-rollup.ts (GitHub Actions wrapper)
 *   - app/api/cleanup/consolidated-invoice-rollup/route.ts (HTTP endpoint)
 */

import { randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import { AUDIT_ACTIONS } from "../../lib/enterprise/audit-actions";
import { BILLABLE_ORG_STATUSES } from "../../lib/enterprise/org-status";

export interface ConsolidatedInvoiceRollupResult {
  success: boolean;
  enabled: boolean;
  parentsScanned: number;
  parentsRolled: number;
  childInvoicesRolled: number;
  skipped: Array<{ parentOrgId: string; reason: string }>;
  errors: string[];
  timestamp: string;
}

function isFlagOn(): boolean {
  return process.env.ENABLE_CONSOLIDATED_INVOICE === "true";
}

function generateInvoiceNumber(parentOrgId: string): string {
  // Mirrors the format used by POST /organizations/[orgId]/billing-account/invoices.
  // The "ROLL-" prefix disambiguates rolled-up invoices from regular
  // billing-account invoices when ops greps the ledger.
  return `ROLL-${parentOrgId.slice(0, 6)}-${Date.now()}-${randomBytes(3)
    .toString("hex")
    .toUpperCase()}`;
}

export async function runConsolidatedInvoiceRollup(): Promise<ConsolidatedInvoiceRollupResult> {
  const now = new Date();
  const errors: string[] = [];
  const skipped: Array<{ parentOrgId: string; reason: string }> = [];

  if (!isFlagOn()) {
    console.log(
      "⏸  ENABLE_CONSOLIDATED_INVOICE is not 'true' — skipping rollup.",
    );
    return {
      success: true,
      enabled: false,
      parentsScanned: 0,
      parentsRolled: 0,
      childInvoicesRolled: 0,
      skipped: [],
      errors: [],
      timestamp: now.toISOString(),
    };
  }

  console.log("🧾 Starting consolidated-invoice rollup...");

  // Scan for parent orgs with at least one child. `depth = 0` narrows to
  // the top-level roots (schema guarantees rootId === self for depth=0).
  const parents = await prisma.organization.findMany({
    where: {
      depth: 0,
      canSponsor: true,
      status: { in: BILLABLE_ORG_STATUSES },
      children: { some: {} },
    },
    select: {
      id: true,
      name: true,
      billingAccountId: true,
      reportingCurrency: true,
      gstin: true,
      hsnDefault: true,
      children: { select: { id: true, name: true } },
    },
  });

  console.log(`   Found ${parents.length} candidate parent org(s).`);

  let parentsRolled = 0;
  let childInvoicesRolled = 0;

  for (const parent of parents) {
    const childIds = parent.children.map((c) => c.id);
    if (!parent.billingAccountId) {
      skipped.push({
        parentOrgId: parent.id,
        reason: "parent has no billingAccount",
      });
      continue;
    }

    try {
      // Pull children's ISSUED invoices in the parent's reporting currency.
      const childInvoices = await prisma.organizationInvoice.findMany({
        where: {
          organizationId: { in: childIds },
          status: "ISSUED",
          displayCurrency: parent.reportingCurrency,
        },
        select: {
          id: true,
          invoiceNumber: true,
          organizationId: true,
          subtotalPaise: true,
          totalPaise: true,
          displayCurrency: true,
          issuedAt: true,
        },
      });

      if (childInvoices.length === 0) {
        skipped.push({
          parentOrgId: parent.id,
          reason: "no outstanding child invoices in parent currency",
        });
        continue;
      }

      const subtotalPaise = childInvoices.reduce(
        (acc, inv) => acc + inv.subtotalPaise,
        0,
      );
      const totalPaise = childInvoices.reduce(
        (acc, inv) => acc + inv.totalPaise,
        0,
      );

      const invoiceNumber = generateInvoiceNumber(parent.id);
      const dueDate = new Date(now);
      dueDate.setDate(dueDate.getDate() + 30); // parent net-30

      const items = childInvoices.map((inv) => {
        const childOrg = parent.children.find((c) => c.id === inv.organizationId);
        return {
          childInvoiceId: inv.id,
          childOrganizationId: inv.organizationId,
          childOrganizationName: childOrg?.name ?? inv.organizationId,
          childInvoiceNumber: inv.invoiceNumber,
          amountPaise: inv.totalPaise,
        };
      });

      await prisma.$transaction(async (tx) => {
        const created = await tx.organizationInvoice.create({
          data: {
            billingAccountId: parent.billingAccountId!,
            organizationId: parent.id,
            invoiceNumber,
            status: "ISSUED",
            displayCurrency: parent.reportingCurrency,
            inrEquivalentPaise: totalPaise,
            subtotalPaise,
            totalPaise,
            // Intra-org transfer — tax breakdown is zero pending CA review.
            // Tracked in the Phase 2 epic; do NOT copy this shortcut to
            // external-party invoices.
            igstPaise: 0,
            cgstPaise: 0,
            sgstPaise: 0,
            taxRate: new Prisma.Decimal(0),
            hsnCode: parent.hsnDefault,
            gstin: parent.gstin,
            autoGenerated: true,
            irpStatus: "PENDING",
            issuedAt: now,
            dueDate,
            billingCycleStart: new Date(
              now.getFullYear(),
              now.getMonth() - 1,
              1,
            ),
            billingCycleEnd: new Date(now.getFullYear(), now.getMonth(), 0),
            items,
          },
        });

        await tx.settlementLedgerEntry.create({
          data: {
            organizationId: parent.id,
            invoiceId: created.id,
            kind: "INVOICE_ISSUED",
            amountPaise: totalPaise,
            currency: parent.reportingCurrency,
          },
        });

        await tx.orgAuditLog.create({
          data: {
            organizationId: parent.id,
            actorMembershipId: null,
            category: "INVOICE",
            action: AUDIT_ACTIONS.INVOICE.INVOICE_ROLLED_UP,
            description: `Consolidated invoice ${invoiceNumber} rolled up ${childInvoices.length} child invoice(s)`,
            details: {
              invoiceId: created.id,
              invoiceNumber,
              totalPaise,
              childInvoiceIds: childInvoices.map((c) => c.id),
              currency: parent.reportingCurrency,
            },
          },
        });
      });

      parentsRolled += 1;
      childInvoicesRolled += childInvoices.length;
      console.log(
        `   ✅ Rolled up ${childInvoices.length} invoice(s) for parent ${parent.id} (${parent.name}).`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`parent ${parent.id}: ${message}`);
      console.error(
        JSON.stringify({
          event: "consolidated_invoice_rollup_failed",
          parentOrgId: parent.id,
          message,
        }),
      );
    }
  }

  return {
    success: errors.length === 0,
    enabled: true,
    parentsScanned: parents.length,
    parentsRolled,
    childInvoicesRolled,
    skipped,
    errors,
    timestamp: now.toISOString(),
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
