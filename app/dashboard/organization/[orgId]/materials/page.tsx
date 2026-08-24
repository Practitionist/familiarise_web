import { requireOrgAccess } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";
import { OrgMaterialsClient } from "./OrgMaterialsClient";

export const metadata = { title: "Materials | Organization Dashboard" };

/**
 * Org catalog materials — read-only metadata inventory (ADR 20). Management
 * happens on the owning consultant's plan editor or via the plan-materials
 * API gated on `catalog.manage`.
 */
export default async function OrgMaterialsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "operations.read",
  });
  if (access.error) return access.error;

  const items = await prisma.planMaterial.findMany({
    where: { organizationId: orgId },
    select: {
      id: true,
      fileName: true,
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
  });

  return (
    <OrgMaterialsClient
      orgId={orgId}
      items={items.map((m) => ({
        ...m,
        planTitle:
          m.consultationPlan?.title ??
          m.subscriptionPlan?.title ??
          m.webinarPlan?.title ??
          m.classPlan?.title ??
          null,
        planType: m.consultationPlan
          ? "CONSULTATION"
          : m.subscriptionPlan
            ? "SUBSCRIPTION"
            : m.webinarPlan
              ? "WEBINAR"
              : "CLASS",
      }))}
    />
  );
}
