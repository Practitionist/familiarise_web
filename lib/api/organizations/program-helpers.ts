/**
 * Program / ProgramAssignment helpers — replaces the old seat-helpers.ts
 * (acquireSeat / releaseSeat) with program-entitlement primitives.
 *
 * A `ProgramAssignment` is the per-member entitlement row — one per
 * (Program, Membership, periodStart) tuple.
 *
 * LICENSED_SEAT programs:
 *   - An assignment represents one "seat" consumed in the current cycle.
 *   - `activeSeatCount` on LicensedSeatConfig tracks the aggregate across
 *     all non-completed assignments.
 *   - `coveredSessionsPerCycle` is the cap per assignment (null =
 *     unlimited — was PREPAID_UNLIMITED).
 *
 * CREDIT_POOL programs:
 *   - An assignment represents access authorization; actual debits hit
 *     the wallet via `walletDebit`.
 *
 * Overage behaviour is driven by `LicensedSeatConfig.overageBehavior`:
 *   - BLOCK: checkout returns 402.
 *   - CHARGE_MEMBER: learner pays overage on own card.
 *   - CHARGE_ORG: overage added to the next invoice cycle.
 */

import type { Prisma, PrismaClient, ProgramAssignment } from "@prisma/client";

export class ProgramAssignmentLimitError extends Error {
  constructor(public programId: string, public membershipId: string) {
    super(
      `Program assignment at overage cap for program=${programId} membership=${membershipId}`,
    );
    this.name = "ProgramAssignmentLimitError";
  }
}

/**
 * Resolve the ACTIVE assignment for a membership against a program for a
 * given point in time. Returns null if no active assignment.
 */
export async function resolveActiveAssignment(
  prisma: PrismaClient | Prisma.TransactionClient,
  params: { programId: string; membershipId: string; at?: Date },
): Promise<ProgramAssignment | null> {
  const at = params.at ?? new Date();
  return prisma.programAssignment.findFirst({
    where: {
      programId: params.programId,
      membershipId: params.membershipId,
      periodStart: { lte: at },
      periodEnd: { gte: at },
    },
  });
}

/**
 * Create or upsert a ProgramAssignment. Used when:
 *   - An org admin assigns a Program to a Membership.
 *   - A cycle rolls over (cron creates next-period rows).
 *
 * The unique constraint (programId, membershipId, periodStart) enforces
 * idempotency.
 */
export async function claimProgramAssignment(
  tx: Prisma.TransactionClient,
  params: {
    programId: string;
    membershipId: string;
    periodStart: Date;
    periodEnd: Date;
  },
): Promise<ProgramAssignment> {
  return tx.programAssignment.upsert({
    where: {
      programId_membershipId_periodStart: {
        programId: params.programId,
        membershipId: params.membershipId,
        periodStart: params.periodStart,
      },
    },
    create: {
      programId: params.programId,
      membershipId: params.membershipId,
      periodStart: params.periodStart,
      periodEnd: params.periodEnd,
    },
    update: {},
  });
}

/**
 * Atomically record a booking utilization against an assignment.
 *
 * For LICENSED_SEAT programs, increments `sessionsUsed` (and
 * `overageCount` when over cap per overageBehavior).
 *
 * For CREDIT_POOL programs, just records the utilization row; the wallet
 * debit is done separately via `walletDebit`.
 *
 * Returns the utilization snapshot. Throws `ProgramAssignmentLimitError`
 * if cap hit and overageBehavior=BLOCK.
 */
export async function recordBookingUtilization(
  tx: Prisma.TransactionClient,
  params: {
    programAssignmentId: string;
    paymentId: string;
    sessionsConsumed: number;
    priceAtBookingPaise: number;
  },
): Promise<{ wasOverage: boolean }> {
  const assignment = await tx.programAssignment.findUniqueOrThrow({
    where: { id: params.programAssignmentId },
    include: {
      program: {
        include: {
          licensedSeatConfig: true,
        },
      },
    },
  });

  let wasOverage = false;
  const cap = assignment.program.licensedSeatConfig?.coveredSessionsPerCycle ?? null;
  const behavior = assignment.program.licensedSeatConfig?.overageBehavior ?? "BLOCK";

  if (cap !== null && assignment.sessionsUsed + params.sessionsConsumed > cap) {
    if (behavior === "BLOCK") {
      throw new ProgramAssignmentLimitError(
        assignment.programId,
        assignment.membershipId,
      );
    }
    wasOverage = true;
  }

  await tx.programAssignment.update({
    where: { id: params.programAssignmentId },
    data: {
      sessionsUsed: { increment: params.sessionsConsumed },
      overageCount: wasOverage ? { increment: 1 } : undefined,
    },
  });

  await tx.bookingUtilization.create({
    data: {
      programAssignmentId: params.programAssignmentId,
      paymentId: params.paymentId,
      sessionsConsumed: params.sessionsConsumed,
      priceAtBookingPaise: params.priceAtBookingPaise,
      wasOverage,
    },
  });

  await tx.usageLedgerEntry.create({
    data: {
      programAssignmentId: params.programAssignmentId,
      membershipId: assignment.membershipId,
      paymentId: params.paymentId,
      sessionsConsumed: params.sessionsConsumed,
      priceAtBookingPaise: params.priceAtBookingPaise,
      wasOverage,
    },
  });

  return { wasOverage };
}

/**
 * Reverse a utilization on refund. Decrements sessionsUsed, writes a
 * correcting UsageLedgerEntry (we don't delete the original — the ledger
 * is append-only for audit).
 */
export async function reverseBookingUtilization(
  tx: Prisma.TransactionClient,
  params: { paymentId: string; reason?: string },
): Promise<{ reversed: boolean }> {
  // Restore sessions via a reversal LEDGER ENTRY, not by deleting the
  // original BookingUtilization row. Deleting would destroy the history
  // needed by analytics ("who used seats in Q1?"), audits ("was this
  // member assigned on 2026-04-10?"), and partial-refund support (we may
  // need to reverse more than once). Instead we stamp `reversedAt` on the
  // row and append an opposing UsageLedgerEntry; the row stays queryable
  // forever, and the ledger sum still nets to the correct usage.
  const util = await tx.bookingUtilization.findUnique({
    where: { paymentId: params.paymentId },
    include: { programAssignment: true },
  });
  if (!util) return { reversed: false };
  if (util.reversedAt) return { reversed: false }; // idempotent

  await tx.programAssignment.update({
    where: { id: util.programAssignmentId },
    data: {
      sessionsUsed: { decrement: util.sessionsConsumed },
      overageCount: util.wasOverage ? { decrement: 1 } : undefined,
    },
  });

  await tx.usageLedgerEntry.create({
    data: {
      programAssignmentId: util.programAssignmentId,
      membershipId: util.programAssignment.membershipId,
      paymentId: params.paymentId,
      sessionsConsumed: -util.sessionsConsumed,
      priceAtBookingPaise: -util.priceAtBookingPaise,
      wasOverage: util.wasOverage,
      notes: params.reason ?? "Reversal on refund",
    },
  });

  await tx.bookingUtilization.update({
    where: { paymentId: params.paymentId },
    data: {
      reversedAt: new Date(),
      reversalReason: params.reason ?? "Refund",
    },
  });
  return { reversed: true };
}
