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
 *   - `coveredEngagementsPerCycle` is the cap per assignment in
 *     *engagement* units (one engagement = one Appointment row = one
 *     calendar occurrence). null = unlimited (was PREPAID_UNLIMITED).
 *     CONSULTATION/WEBINAR debit 1 at checkout; CLASS debits N at
 *     enrolment (one per class day); SUBSCRIPTION debits 1 per
 *     consultant allocation. Per-engagement *price* is governed by
 *     `priceCapPerEngagementPaise` (separate concern).
 *
 * CREDIT_POOL programs:
 *   - An assignment represents access authorization; actual debits hit
 *     the wallet via `walletDebit` against the per-cycle credit cap
 *     (1 credit = ₹1 = 100 paise; see schema.prisma).
 *
 * Overage behaviour is driven by `LicensedSeatConfig.overageBehavior`:
 *   - BLOCK: checkout returns 402.
 *   - CHARGE_MEMBER: learner pays overage on own card.
 *   - CHARGE_ORG: overage added to the next invoice cycle.
 */

import type { Prisma, PrismaClient, ProgramAssignment } from "@prisma/client";

/**
 * Narrowed transaction type for the cap-debit helpers. Structurally
 * identical to `Prisma.TransactionClient` minus the lifecycle methods
 * that aren't usable inside an active transaction anyway. TypeScript's
 * width-subtyping accepts both `Prisma.TransactionClient` and the
 * narrower `PrismaTransaction` defined in `utils/slotAllocation/types.ts`
 * — so callers from either checkout.ts or SlotAllocationService pass
 * without casts.
 */
export type CapTx = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use"
>;

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
  tx: CapTx,
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
 * For LICENSED_SEAT programs, increments `engagementsUsed` (and
 * `overageCount` when over cap per overageBehavior).
 *
 * For CREDIT_POOL programs, just records the utilization row; the wallet
 * debit is done separately via `walletDebit` and the per-cycle credit
 * cap is enforced there (1 credit = ₹1).
 *
 * `engagementsConsumed` is in *engagement* units (one engagement = one
 * Appointment row = one calendar occurrence), NOT slots and NOT bookings.
 * Callers:
 *   - CONSULTATION/WEBINAR: pass at checkout, always 1 (one Appointment).
 *   - CLASS: pass at checkout, equal to the count of distinct
 *     Appointments the learner is being enrolled in (slots are
 *     pre-allocated by the consultant; all appointments are known then).
 *   - SUBSCRIPTION: pass at slot-allocation time
 *     (`SlotAllocationService.createAppointments`), 1 per consultant
 *     allocation — checkout creates only a placeholder appointment for
 *     SUBSCRIPTION and does NOT call this helper.
 *
 * Returns the utilization snapshot. Throws `ProgramAssignmentLimitError`
 * if cap hit and overageBehavior=BLOCK.
 */
export async function recordBookingUtilization(
  tx: CapTx,
  params: {
    programAssignmentId: string;
    paymentId: string;
    engagementsConsumed: number;
    priceAtBookingPaise: number;
  },
): Promise<{ wasOverage: boolean }> {
  // Read the program config once — the cap + behavior values aren't racy
  // (schema-side config is stable across the transaction). The racy part
  // is the engagementsUsed increment, which we perform via a conditional
  // UPDATE so two concurrent bookings can't both pass the cap check.
  const assignment = await tx.programAssignment.findUniqueOrThrow({
    where: { id: params.programAssignmentId },
    select: {
      programId: true,
      membershipId: true,
      program: {
        select: {
          licensedSeatConfig: {
            select: {
              coveredEngagementsPerCycle: true,
              overageBehavior: true,
            },
          },
        },
      },
    },
  });

  const cap =
    assignment.program.licensedSeatConfig?.coveredEngagementsPerCycle ?? null;
  const behavior =
    assignment.program.licensedSeatConfig?.overageBehavior ?? "BLOCK";

  // Atomic conditional increment — mirrors the walletDebit pattern.
  //   - No cap: unconditional increment.
  //   - Cap with BLOCK: increment only if (engagementsUsed + n) <= cap;
  //     returns 0 rows when the cap would be exceeded → throw.
  //   - Cap with CHARGE_MEMBER / CHARGE_ORG: increment unconditionally,
  //     flag overage when the post-increment count exceeds the cap.
  let wasOverage = false;

  if (cap === null) {
    await tx.$executeRaw`
      UPDATE "ProgramAssignment"
      SET "engagementsUsed" = "engagementsUsed" + ${params.engagementsConsumed}
      WHERE "id" = ${params.programAssignmentId}
    `;
  } else if (behavior === "BLOCK") {
    const updated = await tx.$executeRaw`
      UPDATE "ProgramAssignment"
      SET "engagementsUsed" = "engagementsUsed" + ${params.engagementsConsumed}
      WHERE "id" = ${params.programAssignmentId}
        AND "engagementsUsed" + ${params.engagementsConsumed} <= ${cap}
    `;
    if (updated === 0) {
      throw new ProgramAssignmentLimitError(
        assignment.programId,
        assignment.membershipId,
      );
    }
  } else {
    // CHARGE_MEMBER / CHARGE_ORG: increment unconditionally, then flag
    // overage if we crossed the cap. The RETURNING clause avoids a
    // follow-up SELECT for the updated engagementsUsed value.
    const rows = await tx.$queryRaw<Array<{ engagementsUsed: number }>>`
      UPDATE "ProgramAssignment"
      SET "engagementsUsed" = "engagementsUsed" + ${params.engagementsConsumed},
          "overageCount" = "overageCount"
            + CASE WHEN "engagementsUsed" + ${params.engagementsConsumed} > ${cap} THEN 1 ELSE 0 END
      WHERE "id" = ${params.programAssignmentId}
      RETURNING "engagementsUsed"
    `;
    wasOverage = (rows[0]?.engagementsUsed ?? 0) > cap;
  }

  // Upsert the BookingUtilization on paymentId (which is @unique).
  //   - CONSULTATION/WEBINAR/CLASS: called once per Payment, so this is
  //     effectively an insert.
  //   - SUBSCRIPTION: called once per consultant allocation (lazy). The
  //     first allocation inserts the row; subsequent allocations
  //     increment engagementsConsumed by the new delta. priceAtBookingPaise
  //     keeps the original (the upfront subscription price); incremental
  //     allocations pass `priceAtBookingPaise: 0` since no new money
  //     changed hands at allocation time.
  await tx.bookingUtilization.upsert({
    where: { paymentId: params.paymentId },
    create: {
      programAssignmentId: params.programAssignmentId,
      paymentId: params.paymentId,
      engagementsConsumed: params.engagementsConsumed,
      priceAtBookingPaise: params.priceAtBookingPaise,
      wasOverage,
    },
    update: {
      engagementsConsumed: { increment: params.engagementsConsumed },
      // Sticky once true — any allocation that crossed the cap marks
      // the row as having had an overage at some point.
      wasOverage: wasOverage ? true : undefined,
    },
  });

  // The ledger is append-only. Every call writes a fresh row, so the
  // sum across rows for this paymentId equals the BookingUtilization's
  // engagementsConsumed (after upsert).
  await tx.usageLedgerEntry.create({
    data: {
      programAssignmentId: params.programAssignmentId,
      membershipId: assignment.membershipId,
      paymentId: params.paymentId,
      engagementsConsumed: params.engagementsConsumed,
      priceAtBookingPaise: params.priceAtBookingPaise,
      wasOverage,
    },
  });

  return { wasOverage };
}

/**
 * Reverse a utilization on refund. Decrements engagementsUsed, writes a
 * correcting UsageLedgerEntry (we don't delete the original — the ledger
 * is append-only for audit).
 */
export async function reverseBookingUtilization(
  tx: CapTx,
  params: { paymentId: string; reason?: string },
): Promise<{ reversed: boolean }> {
  // Restore engagements via a reversal LEDGER ENTRY, not by deleting the
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
      engagementsUsed: { decrement: util.engagementsConsumed },
      overageCount: util.wasOverage ? { decrement: 1 } : undefined,
    },
  });

  await tx.usageLedgerEntry.create({
    data: {
      programAssignmentId: util.programAssignmentId,
      membershipId: util.programAssignment.membershipId,
      paymentId: params.paymentId,
      engagementsConsumed: -util.engagementsConsumed,
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
