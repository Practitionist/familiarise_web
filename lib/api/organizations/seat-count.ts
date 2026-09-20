import type { Tx } from "@/lib/prisma";
/**
 * BillingSubscription.activeSeatCount writer.
 *
 * `activeSeatCount` is the per-contract aggregate of LICENSED_SEAT
 * ProgramAssignments currently in-period. It is read by the
 * subscription-invoice cron (`jobs/billing/generate-subscription-invoices.ts`)
 * to compute `× N seats` line items on PER_SEAT subscriptions.
 *
 * Atomicity: same conditional-UPDATE pattern as `walletDebit` —
 * a raw SQL `UPDATE ... SET activeSeatCount = activeSeatCount + delta`
 * gated on `activeSeatCount + delta >= 0` so we cannot underflow under
 * concurrent decrement. If two callers race a +1, both succeed; if two
 * race a -1 against a count of 1, exactly one wins (the other throws).
 *
 * Why per-contract and not per-program: `BillingSubscription` is keyed by
 * `contractId @unique`. A contract may bundle multiple LICENSED_SEAT
 * programs (e.g. an org with both a Manager seat-pool and a Learner
 * seat-pool on one master contract). The invoice line-item is the sum
 * across all such programs in that contract — so the write must aggregate
 * at the subscription level, not the program level.
 *
 * Callers must pass the `programId` so we can resolve the right
 * subscription. Non-LICENSED_SEAT programs are no-ops (we still resolve
 * the subscription to validate the program/contract pair, but skip the
 * UPDATE — keeping the call site uniform between program types).
 */

import type { Prisma } from "@prisma/client";

export class SeatCountUnderflowError extends Error {
  constructor(public billingSubscriptionId: string) {
    super(
      `Cannot decrement activeSeatCount below zero on subscription ${billingSubscriptionId}`,
    );
    this.name = "SeatCountUnderflowError";
  }
}

/**
 * Adjust `BillingSubscription.activeSeatCount` by `delta` (signed) for the
 * subscription that owns this LICENSED_SEAT program. Idempotency is the
 * caller's responsibility — the helper just applies the delta. Call once
 * per assignment lifecycle event.
 *
 * No-op if the program is not LICENSED_SEAT or has no associated
 * subscription (e.g. CREDIT_POOL programs, or unbundled contracts).
 */
export async function adjustActiveSeatCount(
  tx: Tx,
  params: {
    programId: string;
    delta: number; // +1 on assignment, -1 on un-assignment
  },
): Promise<{ applied: boolean; balanceAfter: number | null }> {
  if (params.delta === 0) return { applied: false, balanceAfter: null };

  const program = await tx.program.findUnique({
    where: { id: params.programId },
    select: {
      type: true,
      contract: {
        select: {
          subscription: { select: { id: true, activeSeatCount: true } },
        },
      },
    },
  });

  if (!program || program.type !== "LICENSED_SEAT") {
    return { applied: false, balanceAfter: null };
  }
  const sub = program.contract.subscription;
  if (!sub) {
    return { applied: false, balanceAfter: null };
  }

  // Atomic conditional update via the ORM (no raw SQL): same overdraft-guard
  // pattern as walletDebit. For a decrement, updateMany only matches when the
  // current count is large enough to stay non-negative (count >= -delta), so
  // concurrent releases can't underflow.
  if (params.delta < 0) {
    const updated = await tx.billingSubscription.updateMany({
      where: { id: sub.id, activeSeatCount: { gte: -params.delta } },
      data: { activeSeatCount: { increment: params.delta } },
    });
    if (updated.count === 0) {
      throw new SeatCountUnderflowError(sub.id);
    }
  } else {
    await tx.billingSubscription.update({
      where: { id: sub.id },
      data: { activeSeatCount: { increment: params.delta } },
    });
  }

  const after = await tx.billingSubscription.findUniqueOrThrow({
    where: { id: sub.id },
    select: { activeSeatCount: true },
  });
  return { applied: true, balanceAfter: after.activeSeatCount };
}

/**
 * #1744 rows 3/4 + W5 — release the seats a batch of just-closed assignments
 * held: one seat per closed row, in the same transaction that closed them.
 * Program cancel, cycle CLOSE and contract expiry all close by `updateMany`
 * and never released, so PER_SEAT invoicing kept billing dead assignments.
 *
 * Underflow means the count had already drifted low; the close still stands,
 * so the release clamps at zero instead of aborting the caller's transaction.
 * Returns the number of seats actually released.
 */
export async function releaseSeatsForClosedAssignments(
  tx: Tx,
  programId: string,
  closedCount: number,
): Promise<number> {
  if (closedCount <= 0) return 0;
  try {
    const r = await adjustActiveSeatCount(tx, {
      programId,
      delta: -closedCount,
    });
    return r.applied ? closedCount : 0;
  } catch (err) {
    if (!(err instanceof SeatCountUnderflowError)) throw err;
    const sub = await tx.billingSubscription.findUnique({
      where: { id: err.billingSubscriptionId },
      select: { activeSeatCount: true },
    });
    const remaining = sub?.activeSeatCount ?? 0;
    if (remaining > 0) {
      await adjustActiveSeatCount(tx, { programId, delta: -remaining });
    }
    return remaining;
  }
}

/**
 * E2E-audit P1 fix — seat-count release for member-lifecycle cascades.
 *
 * The assignment-cancel paths on the assignment routes already decrement the
 * billed seat, but the MEMBER-level cascades (removal via DELETE/PATCH,
 * SCIM deprovision, DPDP erasure) terminated live ProgramAssignments without
 * releasing their seats — a deprovisioned member stayed fully counted against
 * `activeSeatCount` while any future PER_SEAT enablement would bill them.
 * Call AFTER the assignments have been stamped CANCELLED; pass the same
 * membership ids whose assignments were just terminated. Best-effort per
 * program: non-LICENSED_SEAT programs and unlicensed contracts no-op inside
 * `adjustActiveSeatCount`.
 */
export async function releaseSeatsForTerminatedAssignments(
  tx: Tx,
  membershipIds: string[],
  // #1744 row 4 — the instant the caller stamped as `periodEnd`. Selecting
  // `periodEnd >= new Date()` here matched nothing: the caller's stamp is
  // always a few milliseconds older than this helper's clock, so every
  // member-removal, SCIM and erasure cascade released zero seats.
  closedAt: Date,
): Promise<number> {
  if (membershipIds.length === 0) return 0;

  const terminated = await tx.programAssignment.findMany({
    where: {
      membershipId: { in: membershipIds },
      periodEnd: closedAt,
      status: "CANCELLED",
    },
    select: { programId: true },
  });

  const seen = new Set<string>();
  for (const assignment of terminated) {
    if (seen.has(assignment.programId)) continue;
    seen.add(assignment.programId);
    try {
      await adjustActiveSeatCount(tx, {
        programId: assignment.programId,
        delta: -1,
      });
    } catch (err) {
      // A concurrent double-release losing the underflow guard is a benign
      // outcome (the count is already correct); anything else propagates.
      if (!(err instanceof SeatCountUnderflowError)) throw err;
    }
  }
  return seen.size;
}
