import { NextRequest, NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { previewOverageForBooking } from "@/lib/payments/billing/overage-preview";
import { orgFundingRefusal } from "@/lib/payments/checkout/org-funding";
import {
  CheckoutPreviewQuerySchema,
  type CheckoutPreviewResponse,
} from "@/schemas/organizations";
import type { CoveredPlanType } from "@prisma/client";

/** List price of a plan this org's members can book: live, and public or this org's own. */
async function planListPricePaise(
  orgId: string,
  planType: CoveredPlanType,
  planId: string,
): Promise<number | null> {
  const bookable = {
    id: planId,
    archivedAt: null,
    OR: [
      { visibility: { not: "ORG_ONLY" as const } },
      { organizationId: orgId },
    ],
  };
  const select = { price: true } as const;
  switch (planType) {
    case "CONSULTATION":
      return (
        (
          await prisma.consultationPlan.findFirst({
            where: { ...bookable, status: "PUBLISHED" },
            select,
          })
        )?.price ?? null
      );
    case "SUBSCRIPTION":
      return (
        (
          await prisma.subscriptionPlan.findFirst({
            where: { ...bookable, status: "PUBLISHED" },
            select,
          })
        )?.price ?? null
      );
    case "WEBINAR":
      return (
        (await prisma.webinarPlan.findFirst({ where: bookable, select }))
          ?.price ?? null
      );
    case "CLASS":
      return (
        (await prisma.classPlan.findFirst({ where: bookable, select }))
          ?.price ?? null
      );
  }
}

/**
 * Advisory pre-checkout overage preview. Any ACTIVE member can ask
 * "will booking this plan via this org breach my cap, and what does it cost?".
 *
 * The price is read SERVER-SIDE from the plan (no client-supplied amount, no
 * paise/rupee ambiguity); it's the plan's list price, so the preview is a safe
 * (slight over-) estimate vs the post-discount charge. The authoritative charge
 * is still computed at checkout by `recordOverageAtCheckout`.
 * `fundingRefusal` is the coverage or GST refusal checkout would answer for
 * this payer, so the picker can disable the organisation before Pay.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { readOnly: true });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const parsed = CheckoutPreviewQuerySchema.safeParse({
    planType: url.searchParams.get("planType"),
    planId: url.searchParams.get("planId"),
    sessions: url.searchParams.get("sessions") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid preview params", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const pricePaise = await planListPricePaise(
    orgId,
    parsed.data.planType,
    parsed.data.planId,
  );
  if (pricePaise === null) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  const result = await previewOverageForBooking({
    organizationId: orgId,
    membershipId: access.member.id,
    coveredPlanType: parsed.data.planType,
    bookingPricePaise: pricePaise,
    engagementsConsumed: parsed.data.sessions,
  });
  const fundingRefusal = await orgFundingRefusal(
    orgId,
    access.member.id,
    parsed.data.planType,
  );

  return NextResponse.json({
    ...result,
    fundingRefusal,
  } satisfies CheckoutPreviewResponse);
}
