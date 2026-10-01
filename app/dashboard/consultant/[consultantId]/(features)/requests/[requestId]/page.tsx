import { notFound, redirect } from "next/navigation";

import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import prisma from "@/lib/prisma";
import { isEventIdFormat } from "@/schemas/slotAllocation/validationSchemas";

type PageProps = {
  params: Promise<{ consultantId: string; requestId: string }>;
};

/**
 * /requests/[requestId] has no page of its own; the breadcrumb under the
 * allocate page links here, and it used to 404 (QA #1783 case 12). A request
 * is answered from the inbox, so this resolves the row's type and sends the
 * viewer to the inbox filtered to that tab with the row focused.
 */
export default async function RequestRedirectPage({
  params,
}: Readonly<PageProps>) {
  const { consultantId, requestId } = await params;
  await requirePersonalProfileAccess("consultant", consultantId);
  if (!isEventIdFormat(requestId)) notFound();

  const consultation = await prisma.consultation.findUnique({
    where: { id: requestId },
    select: { consultationPlan: { select: { consultantProfileId: true } } },
  });
  let type: "consultation" | "subscription" | null = null;
  if (consultation?.consultationPlan.consultantProfileId === consultantId) {
    type = "consultation";
  } else {
    const subscription = await prisma.subscription.findUnique({
      where: { id: requestId },
      select: { subscriptionPlan: { select: { consultantProfileId: true } } },
    });
    if (subscription?.subscriptionPlan.consultantProfileId === consultantId) {
      type = "subscription";
    }
  }
  if (!type) notFound();

  redirect(
    `/dashboard/consultant/${encodeURIComponent(consultantId)}/requests?type=${type}&focus=${encodeURIComponent(requestId)}`,
  );
}
