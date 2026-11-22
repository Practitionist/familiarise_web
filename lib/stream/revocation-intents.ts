/**
 * The durable Stream revocation intents, written without the Stream client, so a money transaction
 * can commit the intent it owes with its own rows. `access-revocation` drives them.
 */

import type { CollaboratorType, StreamRevocationKind } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";

/** The revocations a mutating action owes Stream; erasure rows are written by the scrub. */
export type AccessRevocationKind = Exclude<
  StreamRevocationKind,
  "ERASURE_REVOKE"
>;

export interface AccessRevocationTarget {
  kind: AccessRevocationKind;
  userId: string;
  planId: string;
  planType?: CollaboratorType | null;
  counterpartUserId?: string | null;
}

/**
 * Queues revocations for the moderation retry sweep. A target that already has
 * an open row is re-armed, so a capped row cannot swallow a new revocation; the
 * re-arm restarts the room scan, since a re-bought seat may hold earlier rooms again.
 * `nextRetryAt` holds the row back from the sweep while its writer drives it, and
 * the caller makes it fresh on every write, so it names this generation of the rows.
 * Inside a transaction pass its `tx`, so the rows commit or roll back with it.
 */
export async function enqueueStreamRevocationRetries(
  targets: AccessRevocationTarget[],
  nextRetryAt: Date,
  db: Tx = prisma,
): Promise<void> {
  if (targets.length === 0) return;
  await db.streamRevocationRetry.updateMany({
    where: {
      erasureRequestId: null,
      status: { not: "SUCCEEDED" },
      OR: targets.map((t) => ({
        kind: t.kind,
        planId: t.planId,
        userId: t.userId,
      })),
    },
    data: {
      status: "PENDING",
      attempts: 0,
      nextRetryAt,
      lastError: null,
      resumeAfter: null,
    },
  });
  await db.streamRevocationRetry.createMany({
    data: targets.map((t) => ({
      kind: t.kind,
      userId: t.userId,
      planId: t.planId,
      planType: t.planType ?? null,
      counterpartUserId: t.counterpartUserId ?? null,
      nextRetryAt,
    })),
    skipDuplicates: true,
  });
}

/** A fresh intent waits this long for the sweep, so the sweep does not race its writer's drive. */
const INTENT_SWEEP_GRACE_MS = 2 * 60_000;

export const intentNotBefore = () =>
  new Date(Date.now() + INTENT_SWEEP_GRACE_MS);

/** A refund that ended a seat: its `Refund` row and the payer. */
export interface RefundRevocationIntent {
  refundId: string;
  payerUserId: string;
}

export const refundTarget = (intent: RefundRevocationIntent) => ({
  kind: "REFUND_ACCESS_REVOKE" as const,
  userId: intent.payerUserId,
  planId: intent.refundId,
});

/**
 * Writes the refund's revocation intent through the refund's own transaction,
 * so both commit together; a failure rolls the refund back. Returns the row's generation.
 */
export async function persistRefundRevocationInTx(
  tx: Tx,
  intent: RefundRevocationIntent,
): Promise<Date> {
  const generation = intentNotBefore();
  await enqueueStreamRevocationRetries([refundTarget(intent)], generation, tx);
  return generation;
}
