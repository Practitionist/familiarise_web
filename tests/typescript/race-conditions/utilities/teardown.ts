import prisma from "../../../../lib/prisma";
import { apiFetch, type Session } from "./api-client";

const FIXTURE_RETIRED_PREFIX = "REQUIRES_MANUAL_RECOVERY: race harness fixture";

/**
 * Retire SUCCEEDED payments that have no appointment: the orphan sweeps skip
 * any description starting with REQUIRES_MANUAL_RECOVERY, so a fixture row is
 * never "recovered" into a refund or booking. Only the given ids are touched;
 * CAS on the prior description.
 */
export async function retireOrphanSucceededPayments(
  paymentIds: string[],
): Promise<number> {
  const rows = await prisma.payment.findMany({
    where: {
      id: { in: paymentIds },
      paymentStatus: "SUCCEEDED",
      appointmentId: null,
    },
    select: { id: true, description: true },
  });
  let retired = 0;
  for (const row of rows) {
    if (row.description?.startsWith(FIXTURE_RETIRED_PREFIX)) continue;
    const res = await prisma.payment.updateMany({
      where: { id: row.id, description: row.description },
      data: {
        description: `${FIXTURE_RETIRED_PREFIX}${row.description ? ` | ${row.description}` : ""}`,
      },
    });
    retired += res.count;
  }
  return retired;
}

/**
 * Release PENDING checkout holds the way a buyer does — DELETE
 * /api/checkout/pending/:id — so slots, seats and the parent request unwind
 * through the app's CAS. A payment is expired directly only when the API
 * answered "not pending / not found" (never deleted: that would break
 * payment_legs_sum_to_amount). Returns the PENDING count left.
 */
export async function releasePendingHolds(
  sessions: Session[],
  userIds: string[],
  scope: { appointmentId: string; since?: Date },
): Promise<number> {
  const pending = await prisma.payment.findMany({
    where: {
      userId: { in: userIds },
      paymentStatus: "PENDING",
      appointmentId: scope.appointmentId,
      ...(scope.since ? { createdAt: { gte: scope.since } } : {}),
    },
    select: { id: true, userId: true },
  });
  let left = 0;
  for (const p of pending) {
    const owner = sessions[userIds.indexOf(p.userId)];
    const res = owner
      ? await apiFetch(`/api/checkout/pending/${p.id}`, {
          method: "DELETE",
          session: owner,
        })
      : null;
    if (res && (res.status === 404 || res.status === 409)) {
      await prisma.payment.updateMany({
        where: { id: p.id, paymentStatus: "PENDING" },
        data: { paymentStatus: "EXPIRED" },
      });
    } else if (!res || res.status < 200 || res.status >= 300) {
      console.warn(
        `⚠️ release of hold ${p.id} failed: ${res?.status ?? "no session"}`,
      );
    }
    const still = await prisma.payment.count({
      where: { id: p.id, paymentStatus: "PENDING" },
    });
    left += still;
  }
  return left;
}
