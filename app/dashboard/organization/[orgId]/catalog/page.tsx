import { redirect } from "next/navigation";

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { resolveMaterialPlanRef } from "@/lib/plans/material-plan-ref";

import { CatalogClient } from "./CatalogClient";

/**
 * /dashboard/organization/[orgId]/catalog — the offerings this org OWNS.
 *
 * Separate from the sibling `programs` page on purpose, and for the same reason
 * ADR 19 keeps `my-program` separate from `programs`: they are different
 * objects, not two scopes of one. Catalog is host-side — what the org sells.
 * Programs is sponsor-side — the entitlement that funds bookings of anybody's
 * plans. No toggle sensibly spans them.
 *
 * Only Webinar and Class appear here. `ConsultationPlan` and `SubscriptionPlan`
 * require a `consultantProfileId` in the schema, so an org can never solely own
 * one — those stay on the consultant's own Sell pages with the org as a tag.
 */
export default async function OrgCatalogPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    permission: "catalog.manage",
    canHost: true,
  });
  if (access.error) {
    redirect(`/dashboard/organization/${orgId}/home`);
  }

  const [expertMemberships, materials, materialsTotal, orgPlans] =
    await Promise.all([
      readExperts(orgId),
      // #1527-4d — the Materials tab is metadata only (ADR 20).
      prisma.planMaterial.findMany({
        where: { organizationId: orgId },
        select: {
          id: true,
          originalName: true,
          fileSize: true,
          mimeType: true,
          description: true,
          uploadedAt: true,
          consultationPlan: { select: { id: true, title: true } },
          subscriptionPlan: { select: { id: true, title: true } },
          webinarPlan: { select: { id: true, title: true } },
          classPlan: { select: { id: true, title: true } },
        },
        orderBy: { uploadedAt: "desc" },
        take: 200,
      }),
      prisma.planMaterial.count({ where: { organizationId: orgId } }),
      readOrgPlans(orgId),
    ]);

  const experts = expertMemberships.map((m) => ({
    consultantProfileId: m.consultantProfileId as string,
    name: m.user.name ?? m.user.email,
    isVerified: m.consultantProfile?.verificationStatus === "VERIFIED",
  }));

  return (
    <CatalogClient
      orgId={orgId}
      experts={experts}
      materials={materials.map((m) => {
        const planRef = resolveMaterialPlanRef(m);
        return {
          id: m.id,
          originalName: m.originalName,
          fileSize: m.fileSize,
          mimeType: m.mimeType,
          description: m.description,
          uploadedAt: m.uploadedAt,
          planId: planRef?.planId ?? null,
          planTitle: planRef?.title ?? null,
          planType: planRef?.planType ?? "CLASS",
        };
      })}
      materialsTotal={materialsTotal}
      orgPlans={orgPlans}
    />
  );
}

function readExperts(orgId: string) {
  // The pickable deliverers. An org plan with no consultant behind it is not
  // bookable, so the form requires one and the API re-checks the membership —
  // this list is convenience, not authorization.
  return prisma.membership.findMany({
    where: {
      organizationId: orgId,
      status: "ACTIVE",
      role: "EXPERT",
      consultantProfileId: { not: null },
    },
    select: {
      consultantProfileId: true,
      consultantProfile: { select: { verificationStatus: true } },
      user: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

/** The organisation's plans, for Catalog › Materials' plan picker. */
async function readOrgPlans(orgId: string) {
  const where = { organizationId: orgId };
  const select = { id: true, title: true } as const;
  const [consultations, subscriptions, webinars, classes] = await Promise.all([
    prisma.consultationPlan.findMany({ where, select, take: 100 }),
    prisma.subscriptionPlan.findMany({ where, select, take: 100 }),
    prisma.webinarPlan.findMany({ where, select, take: 100 }),
    prisma.classPlan.findMany({ where, select, take: 100 }),
  ]);
  return [
    ...consultations.map((p) => ({ ...p, planType: "CONSULTATION" as const })),
    ...subscriptions.map((p) => ({ ...p, planType: "SUBSCRIPTION" as const })),
    ...webinars.map((p) => ({ ...p, planType: "WEBINAR" as const })),
    ...classes.map((p) => ({ ...p, planType: "CLASS" as const })),
  ];
}
