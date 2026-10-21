/**
 * Who may move support and platform-cancel refunds, and how much.
 *
 * STAFF execute bounded refunds: at most ₹5,000 per payment, counted across
 * every live support remedy on that payment, and at most ₹50,000 per staff
 * member over a rolling 24 hours, summed from their own ops-log rows. ADMIN
 * executes above those limits; the door's second-admin rule still applies.
 */

import type { Prisma, UserRole } from "@prisma/client";
import { z } from "zod";

import type { Tx } from "@/lib/prisma";
import { acquireLock, releaseLock } from "@/lib/redis";
import { countActiveAdmins } from "@/lib/backoffice/ops-proposals";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";

export const STAFF_REFUND_PER_PAYMENT_PAISE = 500_000;
export const STAFF_REFUND_ROLLING_PAISE = 5_000_000;
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const STAFF_REFUND_LOCK_TTL_MS = 120_000;
/** An approval this recent may still be sending its refund outside any transaction. */
export const SUPPORT_REFUND_SEND_GRACE_MS = 15 * 60 * 1000;

/** Ops-log actions whose `after.movedPaise` counts toward the staff rolling limit. */
export const BOUNDED_REFUND_ACTIONS = [
  "support.refund.review",
  "appointment.cancel.platform",
] as const;

const MovedPaise = z.object({ movedPaise: z.number().int().nonnegative() });

function movedPaiseOf(after: Prisma.JsonValue | null): number {
  const parsed = MovedPaise.safeParse(after);
  return parsed.success ? parsed.data.movedPaise : 0;
}

/** Paise this actor moved through bounded refund doors in the trailing 24 hours. */
export async function rollingRefundPaise(
  db: Pick<Tx, "opsActionLog">,
  actorUserId: string,
  now: Date,
): Promise<number> {
  const rows = await db.opsActionLog.findMany({
    where: {
      actorUserId,
      action: { in: [...BOUNDED_REFUND_ACTIONS] },
      createdAt: { gte: new Date(now.getTime() - ROLLING_WINDOW_MS) },
    },
    select: { after: true },
  });
  return rows.reduce((sum, row) => sum + movedPaiseOf(row.after), 0);
}

export interface RefundCharge {
  paymentId: string;
  /** New money this action sends back; 0 for a decline or a keyed replay. */
  newPaise: number;
  /** Money already committed on the payment by other live support remedies. */
  priorPaise: number;
}

export interface MoneyActor {
  userId: string;
  role: UserRole | null;
}

/** Refuses a STAFF refund above the per-payment or rolling limit; ADMIN passes. */
export async function assertBoundedRefund(
  db: Pick<Tx, "opsActionLog">,
  actor: MoneyActor,
  charges: RefundCharge[],
  now = new Date(),
): Promise<void> {
  if (actor.role === "ADMIN") return;
  if (actor.role !== "STAFF") {
    throw new OpsRefusal(
      "FORBIDDEN",
      "This action is not available to your role.",
      403,
    );
  }
  const moving = charges.filter((charge) => charge.newPaise > 0);
  if (moving.length === 0) return;
  if (
    moving.some(
      (charge) =>
        charge.priorPaise + charge.newPaise > STAFF_REFUND_PER_PAYMENT_PAISE,
    )
  ) {
    throw new OpsRefusal(
      "ADMIN_REQUIRED",
      "Refunds above ₹5,000 on one payment need an admin.",
      403,
    );
  }
  const total = moving.reduce((sum, charge) => sum + charge.newPaise, 0);
  const rolling = await rollingRefundPaise(db, actor.userId, now);
  if (rolling + total > STAFF_REFUND_ROLLING_PAISE) {
    throw new OpsRefusal(
      "STAFF_DAILY_LIMIT",
      "You have reached the ₹50,000 staff refund limit for the last 24 hours; an admin must send this refund.",
      403,
    );
  }
}

/**
 * Serializes one staff member's bounded refunds, so parallel requests cannot
 * each pass the rolling limit before the others' ops-log rows land. The door
 * releases it after its ops-log row is written; the TTL covers a lost release.
 */
export async function lockStaffRefunds(
  actor: MoneyActor,
): Promise<() => Promise<void>> {
  if (actor.role !== "STAFF") return () => Promise.resolve();
  const key = `staff-refund:${actor.userId}`;
  const token = await acquireLock(key, STAFF_REFUND_LOCK_TTL_MS);
  if (!token)
    throw new OpsRefusal(
      "STAFF_REFUND_IN_PROGRESS",
      "Another refund of yours is still being sent. Try again in a moment.",
    );
  return () => releaseLock(key, token);
}

/** With two or more active admins, the author of a remedy cannot approve it. */
export async function assertNotOwnRemedy(
  db: Pick<Tx, "user">,
  authorId: string,
  approverId: string,
): Promise<void> {
  if (authorId !== approverId) return;
  if ((await countActiveAdmins(db)) >= 2) {
    throw new OpsRefusal(
      "SAME_AUTHOR",
      "A different operator must approve a refund you recommended.",
      403,
    );
  }
}
