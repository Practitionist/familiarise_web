import prisma from "../../../../lib/prisma";
import { apiFetch, type Session } from "./api-client";

const FIXTURE_RETIRED_PREFIX = "REQUIRES_MANUAL_RECOVERY: race harness fixture";

/**
 * Retire SUCCEEDED payments that have no appointment: the orphan sweeps skip
 * any description starting with REQUIRES_MANUAL_RECOVERY, so a fixture row is
 * never "recovered" into a refund or booking. CAS on the prior description.
 */
export async function retireOrphanSucceededPayments(where: {
  userId?: { in: string[] };
  id?: { in: string[] };
  createdAt?: { gte: Date };
}): Promise<number> {
  const rows = await prisma.payment.findMany({
    where: { ...where, paymentStatus: "SUCCEEDED", appointmentId: null },
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
 * through the app's CAS. Any survivor is expired by CAS (never deleted: that
 * would break payment_legs_sum_to_amount). Returns the PENDING count left.
 */
export async function releasePendingHolds(
  sessions: Session[],
  userIds: string[],
  since?: Date,
): Promise<number> {
  const pending = await prisma.payment.findMany({
    where: {
      userId: { in: userIds },
      paymentStatus: "PENDING",
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    select: { id: true, userId: true },
  });
  for (const p of pending) {
    const owner = sessions[userIds.indexOf(p.userId)];
    if (!owner) continue;
    await apiFetch(`/api/checkout/pending/${p.id}`, {
      method: "DELETE",
      session: owner,
    });
  }
  await prisma.payment.updateMany({
    where: {
      id: { in: pending.map((p) => p.id) },
      paymentStatus: "PENDING",
    },
    data: { paymentStatus: "EXPIRED" },
  });
  return prisma.payment.count({
    where: {
      id: { in: pending.map((p) => p.id) },
      paymentStatus: "PENDING",
    },
  });
}
