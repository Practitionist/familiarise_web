/**
 * Manual trigger for the INVOICED_MONTHLY invoice generator.
 *
 * POST — ORG_OWNER. Aggregates unbilled Payment rows for the calling org and
 * rolls them into a single OrganizationInvoice. Useful for testing and for
 * orgs that want to close out a billing cycle ahead of the monthly cron.
 *
 * Phase K will move the core aggregation logic into
 * `lib/payments/operations/org-invoicing.ts` and call it both from this route
 * and the monthly Inngest cron. For now we inline a minimum-viable version so
 * the dashboard can render real data.
 */

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  determineTax,
  appointmentTypeToServiceType,
} from "@/lib/payments/tax/tax-engine";

function generateInvoiceNumber(orgSlug: string): string {
  const yyyymm = new Date().toISOString().slice(0, 7).replace("-", "");
  const random = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `INV-${orgSlug.slice(0, 8).toUpperCase()}-${yyyymm}-${random}`;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_OWNER");
    if (access.error) return access.error;

    if (access.org.billingMode !== "INVOICED_MONTHLY") {
      return NextResponse.json(
        {
          error: `This operation is only valid for INVOICED_MONTHLY orgs (current mode: ${access.org.billingMode}).`,
        },
        { status: 400 },
      );
    }

    // Aggregate succeeded ORG_INVOICED payments that are not yet billed.
    const unbilled = await prisma.payment.findMany({
      where: {
        organizationProfileId: access.org.id,
        paymentStatus: "SUCCEEDED",
        paymentMethod: "ORG_INVOICED",
        billableToOrgInvoiceId: null,
      },
      select: {
        id: true,
        amount: true,
        createdAt: true,
        appointment: { select: { appointmentType: true } },
        refunds: {
          where: { status: "SUCCEEDED" },
          select: { amount: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    if (unbilled.length === 0) {
      return NextResponse.json(
        { error: "No unbilled payments to invoice for this period." },
        { status: 400 },
      );
    }

    // Net out successful refunds from each payment's billable amount.
    const itemsWithNet = unbilled.map((p) => {
      const refundedTotal = p.refunds.reduce((s, r) => s + r.amount, 0);
      const netAmount = Math.max(0, (p.amount ?? 0) - refundedTotal);
      return {
        paymentId: p.id,
        description: `Booking (${p.appointment?.appointmentType ?? "UNKNOWN"})`,
        quantity: 1,
        unitPrice: netAmount,
      };
    }).filter((item) => item.unitPrice > 0); // Skip fully-refunded bookings

    if (itemsWithNet.length === 0) {
      return NextResponse.json(
        { error: "No billable payments after refund adjustments." },
        { status: 400 },
      );
    }

    const subtotal = itemsWithNet.reduce((sum, item) => sum + item.unitPrice, 0);
    const items = itemsWithNet;

    // Determine the dominant service type for GST/SAC classification.
    // Pick the most frequent appointment type across unbilled payments.
    const typeCounts = unbilled.reduce<Record<string, number>>((acc, p) => {
      const t = p.appointment?.appointmentType ?? "CONSULTATION";
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    }, {});
    const dominantType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "CONSULTATION";
    const serviceType = appointmentTypeToServiceType(dominantType);

    // Enterprise orgs on INVOICED_MONTHLY are currently India-only.
    // TODO: derive buyerCountry from org billing address when international support lands.
    const tax = determineTax({ baseAmountPaise: subtotal, buyerCountry: "IN", serviceType });
    const totalAmount = subtotal + tax.taxAmount;

    const periodStart = unbilled[0].createdAt;
    const periodEnd = unbilled[unbilled.length - 1].createdAt;

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + access.org.paymentTermsDays);

    const organization = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { slug: true },
    });

    const invoice = await prisma.$transaction(async (tx) => {
      const created = await tx.organizationInvoice.create({
        data: {
          organizationProfileId: access.org.id,
          invoiceNumber: generateInvoiceNumber(organization?.slug ?? "ORG"),
          amount: totalAmount,
          currency: "INR",
          status: "SENT",
          items: items as Prisma.InputJsonValue,
          taxAmount: tax.taxAmount,
          taxRate: tax.taxRate / 100, // store as fraction (0.18), consistent with manual invoice
          hsnCode: tax.sacCode,
          billingCycleStart: periodStart,
          billingCycleEnd: periodEnd,
          autoGenerated: false,
          dueDate,
        },
      });

      await tx.payment.updateMany({
        where: { id: { in: unbilled.map((p) => p.id) } },
        data: { billableToOrgInvoiceId: created.id },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationProfileId: access.org.id,
          actorMemberId: access.member.id,
          action: "INVOICE_GENERATED",
          description: `Invoice ${created.invoiceNumber} generated: ${totalAmount / 100} INR (${itemsWithNet.length} sessions)`,
          details: {
            invoiceId: created.id,
            invoiceNumber: created.invoiceNumber,
            subtotal,
            taxAmount: tax.taxAmount,
            total: totalAmount,
            paymentCount: itemsWithNet.length,
          },
        },
      });

      return created;
    });

    return NextResponse.json({ invoice }, { status: 201 });
  } catch (error) {
    console.error(
      "[API /organizations/[orgId]/billing/generate-invoice POST] error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to generate invoice" },
      { status: 500 },
    );
  }
}
