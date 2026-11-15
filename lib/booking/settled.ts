import type { PrismaLike, Tx } from "@/lib/prisma";
import {
  SETTLED_CONSULTATION,
  SETTLED_SUBSCRIPTION,
} from "@/lib/booking/approve-request";

/**
 * Paid or free: a session placed on it needs only the 15-minute lead. The
 * reschedule route and the reschedule pages read this one answer.
 */
export async function bookingSettled(
  db: Pick<PrismaLike | Tx, "consultation" | "subscription">,
  parent: { consultationId?: string | null; subscriptionId?: string | null },
): Promise<boolean> {
  if (parent.consultationId) {
    return (
      (await db.consultation.count({
        where: { id: parent.consultationId, ...SETTLED_CONSULTATION },
      })) > 0
    );
  }
  if (parent.subscriptionId) {
    return (
      (await db.subscription.count({
        where: { id: parent.subscriptionId, ...SETTLED_SUBSCRIPTION },
      })) > 0
    );
  }
  return true;
}
