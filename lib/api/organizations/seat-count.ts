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

import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  ASSIGNMENT_ALLOWED_FROM,
  IllegalTransitionError,
} from "@/lib/enterprise/transitions";

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

/**
 * #1846 SM-C14 / #1851 decision 3 — a contract that ends (manual TERMINATED or
 * EXPIRED, or the nightly expiry job) closes every live seat under it: ACTIVE
 * and PAUSED assignments move to CLOSED with the allowed-from set in the
 * WHERE (the assignment CAS, set-based), a seat
 * still in period ends now, the billed seat count is released, and each seat
 * gets its own audit row so the member's timeline shows why it ended. The
 * programs themselves move to EXPIRED. Returns the number of seats closed.
 */
export async function closeContractSeats(
  tx: Tx,
  args: {
    contractId: string;
    organizationId: string;
    /** Null for the expiry job, which acts as the platform. */
    actorMembershipId: string | null;
    contractStatus: "TERMINATED" | "EXPIRED";
    now: Date;
  },
): Promise<number> {
  const { contractId, organizationId, actorMembershipId, now } = args;
  await tx.program.updateMany({
    where: { contractId, status: { in: ["ACTIVE", "PAUSED"] } },
    data: { status: "EXPIRED" },
  });
  const live = await tx.programAssignment.findMany({
    where: { program: { contractId }, status: { in: ["ACTIVE", "PAUSED"] } },
    select: { id: true, programId: true, membershipId: true, periodEnd: true },
  });
  if (live.length === 0) return 0;

  // Set-based so a contract with hundreds of seats stays a handful of
  // statements inside the caller's transaction. The allowed-from set rides
  // the WHERE (ASSIGNMENT_ALLOWED_FROM.CLOSED); a seat still in period ends
  // now, one past its period keeps its real end.
  const ids = live.map((seat) => seat.id);
  const from = { in: ASSIGNMENT_ALLOWED_FROM.CLOSED };
  const inPeriod = await tx.programAssignment.updateMany({
    where: { id: { in: ids }, status: from, periodEnd: { gt: now } },
    data: { status: "CLOSED", periodEnd: now },
  });
  const pastPeriod = await tx.programAssignment.updateMany({
    where: { id: { in: ids }, status: from, periodEnd: { lte: now } },
    data: { status: "CLOSED" },
  });
  // A seat that moved underneath the read (a concurrent cancel or roll) is a
  // lost race: refuse rather than audit a close that did not happen.
  if (inPeriod.count + pastPeriod.count !== live.length) {
    throw new IllegalTransitionError("ProgramAssignment", "CLOSED");
  }

  await tx.orgAuditLog.createMany({
    data: live.map((seat) => ({
      organizationId,
      actorMembershipId,
      targetMembershipId: seat.membershipId,
      category: "PROGRAM" as const,
      action: AUDIT_ACTIONS.PROGRAM.ASSIGNMENT_CLOSED_BY_CONTRACT,
      description: `Seat ${seat.id} closed: contract ${contractId} ${args.contractStatus.toLowerCase()}`,
      details: {
        contractId,
        programId: seat.programId,
        assignmentId: seat.id,
        membershipId: seat.membershipId,
        contractStatus: args.contractStatus,
      },
    })),
  });

  const closedPerProgram = new Map<string, number>();
  for (const seat of live) {
    closedPerProgram.set(
      seat.programId,
      (closedPerProgram.get(seat.programId) ?? 0) + 1,
    );
  }
  for (const [programId, count] of closedPerProgram) {
    await releaseSeatsForClosedAssignments(tx, programId, count);
  }
  return live.length;
}
