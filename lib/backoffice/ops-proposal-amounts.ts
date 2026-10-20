/**
 * What each org money door would move, for the second-approval threshold. Kept
 * apart from ops-proposals so the door shell does not load the billing graph.
 */

import prisma from "@/lib/prisma";
import { orgSurchargeTaxPaise } from "@/lib/payments/billing/overage-settlement";

/** An org invoice's total, the amount its void or issue moves; 0 when not found. */
export async function orgInvoiceTotalPaise(
  organizationId: string,
  invoiceId: string,
): Promise<number> {
  const invoice = await prisma.organizationInvoice.findFirst({
    where: { id: invoiceId, organizationId },
    select: { totalPaise: true },
  });
  return invoice?.totalPaise ?? 0;
}

/** What settling a member overage to the org accrues: base, surcharge and the org's GST on it. */
export async function overageSettlementPaise(
  organizationId: string,
  overageEventId: string,
): Promise<number> {
  const event = await prisma.overageEvent.findUnique({
    where: { id: overageEventId },
    select: { basePaise: true, surchargePaise: true },
  });
  if (!event) return 0;
  return (
    event.basePaise +
    event.surchargePaise +
    (await orgSurchargeTaxPaise(prisma, organizationId, event.surchargePaise))
  );
}

/**
 * How far a credit-limit change raises it; null (unlimited) is unbounded. Credit is
 * extended only on INVOICE funding, so a switch to it raises from zero.
 */
export async function creditLimitRaisePaise(
  ownerOrgId: string,
  body: { creditLimit?: number | null; fundingSource?: "INVOICE" },
): Promise<number> {
  const account = await prisma.billingAccount.findFirst({
    where: { ownerOrgId },
    select: { creditLimit: true, fundingSource: true },
  });
  if (!account) return 0;
  const switching =
    body.fundingSource === "INVOICE" && account.fundingSource !== "INVOICE";
  if (!switching && body.creditLimit === undefined) return 0;
  const next =
    body.creditLimit === undefined ? account.creditLimit : body.creditLimit;
  const prev = switching ? 0 : account.creditLimit;
  if (next === null) return prev === null ? 0 : Number.POSITIVE_INFINITY;
  if (prev === null) return 0;
  return Math.max(0, next - prev);
}

/** An org payout's net (pre-withholding) amount, what its approval releases. */
export async function orgPayoutNetPaise(payoutId: string): Promise<number> {
  const payout = await prisma.organizationPayout.findUnique({
    where: { id: payoutId },
    select: { netPayoutPaise: true },
  });
  return payout?.netPayoutPaise ?? 0;
}
