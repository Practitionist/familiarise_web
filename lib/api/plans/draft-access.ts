import type { OfferingPlanStatus } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import { reportSentryError } from "@/lib/observability/report";
import { planSaleRefusal } from "@/lib/api/plans/visibility";

/**
 * #1527 Q4 — true when a 1:1 or subscription plan is a DRAFT and the caller is
 * not its author, so the by-id GET answers 404 exactly as for a missing row.
 * The session is read only for drafts, so published plans cost nothing extra.
 */
export async function isHiddenDraft(plan: {
  status: OfferingPlanStatus;
  consultantProfileId: string;
}): Promise<boolean> {
  if (!planSaleRefusal(plan)) return false;
  const session = await getSession(true).catch((error: unknown) => {
    reportSentryError(error, { subsystem: "plans", expected: true });
    return null;
  });
  return session?.user?.consultantProfileId !== plan.consultantProfileId;
}
