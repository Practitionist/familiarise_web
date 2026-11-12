import type { Tx, PrismaLike } from "@/lib/prisma";
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

import type { ProgramAssignment, ProgramType } from "@prisma/client";
import { transitionOverage } from "@/lib/payments/billing/overage-transitions";
import { voidReversedOverageAccruals } from "@/lib/payments/billing/overage-accrual-void";
import { releaseOverageHeldParentEarnings } from "@/lib/payments/billing/overage-base-carve";

// #780 — reads come through the extended client (money as number); the raw
// model type still says bigint.
type ProgramAssignmentRow = Omit<ProgramAssignment, "consumedPaise"> & {
  consumedPaise: number;
};

export class ProgramAssignmentLimitError extends Error {
  constructor(
    public programId: string,
    public membershipId: string,
  ) {
    super(
      `Program assignment at overage cap for program=${programId} membership=${membershipId}`,
    );
    this.name = "ProgramAssignmentLimitError";
  }
}

/**
 * A reversal asked for more than the counters hold.
 *
 * `reverseBookingUtilization` guards its decrement with `gte` predicates, so a
 * counter that has already drifted below zero (or below the amount being
 * returned) matches zero rows and this is raised instead of writing the row.
 * It is an OPERATOR signal, not a buyer-facing one: the meters are derived
 * caches over `UsageLedgerEntry`, and the only way they can be short is if some
 * earlier writer moved them without the ledger — so the message names the
 * assignment and the delta that would have driven it negative, which is what
 * `scripts/reconcile/reconcile-ledgers.ts` needs to find the offending trail.
 */
export class ProgramAssignmentUnderflowError extends Error {
  readonly httpStatus = 500;
  constructor(
    public programAssignmentId: string,
    public engagementsToReverse: number,
    public paiseToReverse: number,
  ) {
    super(
      `Program assignment ${programAssignmentId} cannot release ${engagementsToReverse} engagement(s) / ${paiseToReverse} paise: its counters are lower than the reversal (UsageLedgerEntry drift — run reconcile-ledgers).`,
    );
    this.name = "ProgramAssignmentUnderflowError";
  }
}

/**
 * Resolve the ACTIVE assignment for a membership against a program for a
 * given point in time. Returns null if no active assignment.
 */
export async function resolveActiveAssignment(
  prisma: PrismaLike,
  params: { programId: string; membershipId: string; at?: Date },
): Promise<ProgramAssignmentRow | null> {
  const at = params.at ?? new Date();
  return prisma.programAssignment.findFirst({
    where: {
      programId: params.programId,
      membershipId: params.membershipId,
      periodStart: { lte: at },
      periodEnd: { gte: at },
    },
    // #750 — boundary instants (periodEnd == next periodStart) match two
    // rows; without an order the pick is arbitrary. Latest cycle wins,
    // consistent with checkout's resolver.
    orderBy: { periodEnd: "desc" },
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
export class ProgramAssignmentOverlapError extends Error {
  readonly httpStatus = 409;
  constructor(
    public programId: string,
    public membershipId: string,
  ) {
    super(
      `An assignment for this member already covers an overlapping period on program=${programId}`,
    );
    this.name = "ProgramAssignmentOverlapError";
  }
}

export async function claimProgramAssignment(
  tx: Tx,
  params: {
    programId: string;
    membershipId: string;
    periodStart: Date;
    periodEnd: Date;
  },
): Promise<{ assignment: ProgramAssignmentRow; created: boolean }> {
  // #778 §B — the @@unique on (programId, membershipId, periodStart) can't
  // stop two OVERLAPPING cycles with different starts, and Postgres exclusion
  // constraints aren't Prisma-expressible. Overlap double-counts caps/seats in
  // reconcile, so reject here; the exact-same-periodStart re-claim stays
  // idempotent via the createMany path below.
  const overlapping = await tx.programAssignment.findFirst({
    where: {
      programId: params.programId,
      membershipId: params.membershipId,
      status: "ACTIVE",
      periodStart: { lt: params.periodEnd, not: params.periodStart },
      periodEnd: { gt: params.periodStart },
    },
    select: { id: true },
  });
  if (overlapping) {
    throw new ProgramAssignmentOverlapError(
      params.programId,
      params.membershipId,
    );
  }

  // #785 — report whether THIS call created the row so the caller can
  // increment activeSeatCount exactly once. `createMany({ skipDuplicates })`
  // is INSERT … ON CONFLICT DO NOTHING: it returns count===1 for the single
  // racer that wins the unique (programId, membershipId, periodStart) and
  // count===0 for a re-claim/concurrent duplicate — and, unlike a caught
  // P2002, does NOT poison the surrounding transaction. Replaces the route's
  // racy preexisting-probe that let two concurrent POSTs both seat-count.
  const ins = await tx.programAssignment.createMany({
    data: [
      {
        programId: params.programId,
        membershipId: params.membershipId,
        periodStart: params.periodStart,
        periodEnd: params.periodEnd,
      },
    ],
    skipDuplicates: true,
  });
  const assignment = await tx.programAssignment.findUniqueOrThrow({
    where: {
      programId_membershipId_periodStart: {
        programId: params.programId,
        membershipId: params.membershipId,
        periodStart: params.periodStart,
      },
    },
  });
  return { assignment, created: ins.count === 1 };
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
 *     (`createAppointments` in lib/booking/allocation/commit), 1 per consultant
 *     allocation — checkout creates only a placeholder appointment for
 *     SUBSCRIPTION and does NOT call this helper.
 *
 * Returns the utilization snapshot. Throws `ProgramAssignmentLimitError`
 * if cap hit and overageBehavior=BLOCK.
 */
export async function recordBookingUtilization(
  tx: Tx,
  params: {
    programAssignmentId: string;
    paymentId: string;
    engagementsConsumed: number;
    priceAtBookingPaise: number;
    /**
     * PR-1e (G3): identifiers of the appointments this call is counting.
     * When provided, the helper compares against the BookingUtilization's
     * `appointmentIds` set and only counts the *new* members of `incoming
     * - alreadyTracked`. Re-allocation (delete + recreate) flows that pass
     *  the same appointment id twice become idempotent.
     *
     * For CONSULTATION/WEBINAR/CLASS the caller knows all appointments
     * up front, so passing them here turns the upsert into a true
     * idempotent operation. For SUBSCRIPTION the caller passes whatever
     * appointment ids are being added in this allocation batch.
     *
     * If omitted (legacy callers), behavior is unchanged: every call
     * unconditionally increments by `engagementsConsumed`.
     */
    appointmentIds?: string[];
  },
): Promise<{
  wasOverage: boolean;
  engagementsConsumedDelta: number;
  // #768 #22 — post-increment cap state so the caller can detect the
  // <80% → >=80% cap-near transition. `cap` null = unlimited (no warning).
  engagementsUsedAfter: number;
  cap: number | null;
  // #775/#753 — CREDIT_POOL money-meter. `programType` lets the caller pick
  // the right computeOverage() shape; `consumedPaiseAfter`/`creditBudgetPaise`
  // drive the meter + cap-near for CREDIT_POOL (both null/0 for LICENSED_SEAT).
  programType: ProgramType;
  consumedPaiseAfter: number;
  creditBudgetPaise: number | null;
  /** The ledger row this call wrote; it keys an over-cap batch's OverageEvent. */
  usageLedgerEntryId: string | null;
}> {
  if (params.engagementsConsumed < 0) {
    throw new Error(
      `recordBookingUtilization: engagementsConsumed must be non-negative; got ${params.engagementsConsumed}`,
    );
  }

  // Read the program config once — the cap + behavior values aren't racy
  // (schema-side config is stable across the transaction). The racy part
  // is the engagementsUsed increment, which we perform via a conditional
  // UPDATE so two concurrent bookings can't both pass the cap check.
  const assignment = await tx.programAssignment.findUniqueOrThrow({
    where: { id: params.programAssignmentId },
    select: {
      programId: true,
      membershipId: true,
      // #768 #22 — pre-increment count. The BLOCK / unlimited branches use a
      // bare conditional UPDATE (no RETURNING) so we derive engagementsUsedAfter
      // as preCount + delta; the CHARGE_* branch reads the post value directly.
      engagementsUsed: true,
      // #775/#753 — CREDIT_POOL money-meter pre-increment value.
      consumedPaise: true,
      program: {
        select: {
          type: true,
          licensedSeatConfig: {
            select: {
              coveredEngagementsPerCycle: true,
              overageBehavior: true,
            },
          },
          creditPoolConfig: {
            select: {
              creditBudgetPerCycle: true,
              priceCapPerEngagementPaise: true,
              overageBehavior: true,
            },
          },
        },
      },
    },
  });

  // PR-1e (G3): if the caller provided appointmentIds, dedup against
  // any already counted on this BookingUtilization row. The new delta
  // is the count of incoming ids NOT yet tracked. Skip the helper
  // entirely if nothing new to count.
  let actualDelta = params.engagementsConsumed;
  let newAppointmentIds: string[] | undefined;
  if (params.appointmentIds !== undefined) {
    const existing = await tx.bookingUtilization.findUnique({
      where: { paymentId: params.paymentId },
      select: { appointmentIds: true },
    });
    const alreadyTracked = new Set(existing?.appointmentIds ?? []);
    newAppointmentIds = params.appointmentIds.filter(
      (id) => !alreadyTracked.has(id),
    );
    actualDelta = newAppointmentIds.length;
    if (actualDelta === 0) {
      return {
        wasOverage: false,
        engagementsConsumedDelta: 0,
        engagementsUsedAfter: assignment.engagementsUsed ?? 0,
        cap: null,
        programType: assignment.program.type ?? "LICENSED_SEAT",
        consumedPaiseAfter: assignment.consumedPaise ?? 0,
        creditBudgetPaise: null,
        usageLedgerEntryId: null,
      };
    }
  } else if (params.engagementsConsumed === 0) {
    // No appointmentIds + zero delta = nothing to do (legacy callers).
    return {
      wasOverage: false,
      engagementsConsumedDelta: 0,
      engagementsUsedAfter: assignment.engagementsUsed ?? 0,
      cap: null,
      programType: assignment.program.type ?? "LICENSED_SEAT",
      consumedPaiseAfter: assignment.consumedPaise ?? 0,
      creditBudgetPaise: null,
      usageLedgerEntryId: null,
    };
  }

  // LICENSED_SEAT meters by engagement COUNT against
  // `coveredEngagementsPerCycle`; CREDIT_POOL meters by PAISE against
  // `creditBudgetPerCycle × 100` (1 credit = ₹1). Pick the unit + behavior source.
  const programType: ProgramType = assignment.program.type ?? "LICENSED_SEAT";
  const isCredit = programType === "CREDIT_POOL";
  const cap = isCredit
    ? null
    : (assignment.program.licensedSeatConfig?.coveredEngagementsPerCycle ??
      null);
  const creditBudgetPaise = isCredit
    ? (assignment.program.creditPoolConfig?.creditBudgetPerCycle ?? 0) * 100
    : null;
  const behavior = isCredit
    ? (assignment.program.creditPoolConfig?.overageBehavior ?? "BLOCK")
    : (assignment.program.licensedSeatConfig?.overageBehavior ?? "BLOCK");
  const pricePaise = Math.max(0, Math.floor(params.priceAtBookingPaise));

  // Atomic conditional increment — mirrors the walletDebit pattern, but via
  // Prisma's typed API. A numeric guard in `updateMany.where` compiles to a
  // single `UPDATE … WHERE meter <= cap - delta`, so it's exactly as atomic as
  // raw SQL (two concurrent bookings can't both pass) while staying type-safe:
  //   - No cap: unconditional increment.
  //   - Cap with BLOCK: guarded increment; count===0 ⇒ cap exceeded → throw.
  //   - Cap with CHARGE_*: unconditional increment (post value from `update`),
  //     flag overage when it crossed the cap; bump overageCount only then.
  let wasOverage = false;
  // Post-increment count so the caller can compute the cap-near
  // transition. BLOCK / unlimited derive it as preCount + delta; CHARGE_* read
  // the authoritative post value from the `update` return.
  const preCount = assignment.engagementsUsed ?? 0;
  let engagementsUsedAfter = preCount + actualDelta;
  // CREDIT_POOL money-meter post value (always advances engagementsUsed too so
  // the reconcile invariant on engagementsUsed still holds for credit pools).
  let consumedPaiseAfter =
    (assignment.consumedPaise ?? 0) + (isCredit ? pricePaise : 0);

  if (isCredit) {
    const budget = creditBudgetPaise ?? 0;
    const rawCreditPriceCap =
      assignment.program.creditPoolConfig?.priceCapPerEngagementPaise ?? null;
    const creditPriceCap =
      rawCreditPriceCap !== null ? Number(rawCreditPriceCap) : null;
    const exceedsEngagementCap =
      creditPriceCap !== null && pricePaise > actualDelta * creditPriceCap;
    if (behavior === "BLOCK") {
      if (exceedsEngagementCap) {
        throw new ProgramAssignmentLimitError(
          assignment.programId,
          assignment.membershipId,
        );
      }
      const res = await tx.programAssignment.updateMany({
        where: {
          id: params.programAssignmentId,
          consumedPaise: { lte: budget - pricePaise },
        },
        data: {
          engagementsUsed: { increment: actualDelta },
          consumedPaise: { increment: pricePaise },
        },
      });
      if (res.count === 0) {
        throw new ProgramAssignmentLimitError(
          assignment.programId,
          assignment.membershipId,
        );
      }
    } else {
      const updated = await tx.programAssignment.update({
        where: { id: params.programAssignmentId },
        data: {
          engagementsUsed: { increment: actualDelta },
          consumedPaise: { increment: pricePaise },
        },
        select: { engagementsUsed: true, consumedPaise: true },
      });
      engagementsUsedAfter = updated.engagementsUsed;
      consumedPaiseAfter = updated.consumedPaise;
      wasOverage = consumedPaiseAfter > budget || exceedsEngagementCap;
      if (wasOverage) {
        await tx.programAssignment.update({
          where: { id: params.programAssignmentId },
          data: { overageCount: { increment: 1 } },
        });
      }
    }
  } else if (cap === null) {
    await tx.programAssignment.update({
      where: { id: params.programAssignmentId },
      data: { engagementsUsed: { increment: actualDelta } },
    });
  } else if (behavior === "BLOCK") {
    const res = await tx.programAssignment.updateMany({
      where: {
        id: params.programAssignmentId,
        engagementsUsed: { lte: cap - actualDelta },
      },
      data: { engagementsUsed: { increment: actualDelta } },
    });
    if (res.count === 0) {
      throw new ProgramAssignmentLimitError(
        assignment.programId,
        assignment.membershipId,
      );
    }
  } else {
    // CHARGE_MEMBER / CHARGE_ORG: unconditional increment; `update` returns the
    // post value (no follow-up SELECT). overageCount bumps only when this
    // booking actually crossed the cap.
    const updated = await tx.programAssignment.update({
      where: { id: params.programAssignmentId },
      data: { engagementsUsed: { increment: actualDelta } },
      select: { engagementsUsed: true },
    });
    engagementsUsedAfter = updated.engagementsUsed;
    wasOverage = engagementsUsedAfter > cap;
    if (wasOverage) {
      await tx.programAssignment.update({
        where: { id: params.programAssignmentId },
        data: { overageCount: { increment: 1 } },
      });
    }
  }

  // Upsert the BookingUtilization on paymentId (which is @unique). The row's
  // engagementsConsumed and priceAtBookingPaise are the sums of its positive
  // ledger rows, which is what reverseBookingUtilization prorates against.
  await tx.bookingUtilization.upsert({
    where: { paymentId: params.paymentId },
    create: {
      programAssignmentId: params.programAssignmentId,
      paymentId: params.paymentId,
      engagementsConsumed: actualDelta,
      priceAtBookingPaise: params.priceAtBookingPaise,
      wasOverage,
      appointmentIds: newAppointmentIds ?? [],
    },
    update: {
      engagementsConsumed: { increment: actualDelta },
      priceAtBookingPaise: { increment: params.priceAtBookingPaise },
      // Sticky once true — any allocation that crossed the cap marks
      // the row as having had an overage at some point.
      wasOverage: wasOverage ? true : undefined,
      appointmentIds: newAppointmentIds
        ? { push: newAppointmentIds }
        : undefined,
    },
  });

  // The ledger is append-only. Every call writes a fresh row, so the
  // sum across rows for this paymentId equals the BookingUtilization's
  // engagementsConsumed (after upsert).
  const ledgerEntry = await tx.usageLedgerEntry.create({
    data: {
      programAssignmentId: params.programAssignmentId,
      membershipId: assignment.membershipId,
      paymentId: params.paymentId,
      engagementsConsumed: actualDelta,
      priceAtBookingPaise: params.priceAtBookingPaise,
      wasOverage,
    },
  });

  return {
    wasOverage,
    engagementsConsumedDelta: actualDelta,
    engagementsUsedAfter,
    cap,
    programType,
    consumedPaiseAfter,
    creditBudgetPaise,
    usageLedgerEntryId: ledgerEntry.id,
  };
}

/** One sale's metered and reversed totals, read from the usage ledger. */
interface SaleLedger {
  consumed: number;
  pricePaise: number;
  overCapBatches: number;
  reversed: number;
  reversedPaise: number;
}

/**
 * The current sale of a payment: its ledger rows since the previous sale was
 * fully reversed, engagements and paise alike. A re-minted seat reuses the
 * payment id, so a metering that follows a full reversal opens a new sale.
 */
async function currentSaleLedger(
  tx: Tx,
  paymentId: string,
): Promise<SaleLedger> {
  const rows = await tx.usageLedgerEntry.findMany({
    where: { paymentId },
    // One allocation writes its reversal before its metering, so a timestamp tie sorts negatives first.
    orderBy: [{ createdAt: "asc" }, { engagementsConsumed: "asc" }],
    select: {
      engagementsConsumed: true,
      priceAtBookingPaise: true,
      wasOverage: true,
    },
  });
  const empty = (): SaleLedger => ({
    consumed: 0,
    pricePaise: 0,
    overCapBatches: 0,
    reversed: 0,
    reversedPaise: 0,
  });
  let sale = empty();
  for (const row of rows) {
    if (row.engagementsConsumed > 0) {
      const closed =
        sale.consumed > 0 &&
        sale.reversed >= sale.consumed &&
        sale.reversedPaise >= sale.pricePaise;
      if (closed) sale = empty();
      sale.consumed += row.engagementsConsumed;
      sale.pricePaise += row.priceAtBookingPaise;
      if (row.wasOverage) sale.overCapBatches += 1;
    } else {
      sale.reversed -= row.engagementsConsumed;
      sale.reversedPaise -= row.priceAtBookingPaise;
    }
  }
  return sale;
}

/**
 * Reverse a utilization on refund. Decrements the assignment's meters and
 * appends a negative UsageLedgerEntry; the utilization row is never deleted.
 *
 * Everything is measured against the payment's current sale (see
 * `currentSaleLedger`), so a re-minted seat never returns an earlier sale's
 * credit. With no `engagementsToReverse` the call reverses the whole sale, or
 * a refund's share of it when `refundRatio` is given; repeated partial calls
 * accumulate and clamp to what the sale still holds. `reversedAt` is stamped
 * when the sale is fully reversed.
 *
 * The counter decrement is a guarded CAS, so a meter that has drifted
 * below what this call returns raises `ProgramAssignmentUnderflowError`
 * (rolling the reversal back) instead of going further negative.
 */
export async function reverseBookingUtilization(
  tx: Tx,
  params: {
    paymentId: string;
    reason?: string;
    /** Engagements to reverse; negative or zero is a no-op. */
    engagementsToReverse?: number;
    /**
     * The refund's share of the payment. It sizes the money-meter reversal,
     * and the engagement count when `engagementsToReverse` is omitted (a
     * partial refund still releases at least one engagement).
     */
    refundRatio?: { refundAmountPaise: number; paymentAmountPaise: number };
  },
): Promise<{
  reversed: boolean;
  engagementsReversed: number;
  fullyReversed: boolean;
}> {
  const util = await tx.bookingUtilization.findUnique({
    where: { paymentId: params.paymentId },
    include: {
      programAssignment: {
        include: { program: { select: { type: true } } },
      },
    },
  });
  if (!util) {
    return { reversed: false, engagementsReversed: 0, fullyReversed: false };
  }

  const sale = await currentSaleLedger(tx, params.paymentId);
  const remainingReversible = Math.max(0, sale.consumed - sale.reversed);
  const remainingPrice = Math.max(0, sale.pricePaise - sale.reversedPaise);
  const ratio =
    params.refundRatio && params.refundRatio.paymentAmountPaise > 0
      ? params.refundRatio
      : null;
  const isCreditPool = util.programAssignment.program?.type === "CREDIT_POOL";
  // A ratio refund that lands after the sale's engagements are spent still
  // returns its share of a credit pool's paise.
  const paiseOnly =
    remainingReversible === 0 && isCreditPool && !!ratio && remainingPrice > 0;
  if (remainingReversible === 0 && !paiseOnly) {
    return { reversed: false, engagementsReversed: 0, fullyReversed: true };
  }

  let target = sale.consumed;
  if (params.engagementsToReverse !== undefined) {
    target = Math.max(0, params.engagementsToReverse);
  } else if (ratio && ratio.refundAmountPaise < ratio.paymentAmountPaise) {
    target = Math.max(
      1,
      Math.ceil(
        (sale.consumed * ratio.refundAmountPaise) / ratio.paymentAmountPaise,
      ),
    );
  }
  const actualReversal = Math.min(target, remainingReversible);
  if (actualReversal <= 0 && !paiseOnly) {
    return { reversed: false, engagementsReversed: 0, fullyReversed: false };
  }

  const willBeFullyReversed =
    actualReversal > 0 && sale.reversed + actualReversal >= sale.consumed;

  // The price follows the engagements, or the money actually refunded when a
  // ratio is given, clamped to what the sale has not yet returned.
  let priceReversal =
    actualReversal > 0
      ? Math.round((sale.pricePaise * actualReversal) / sale.consumed)
      : 0;
  if (ratio) {
    const proportional = Math.floor(
      (sale.pricePaise * ratio.refundAmountPaise) / ratio.paymentAmountPaise,
    );
    priceReversal = Math.min(Math.max(0, proportional), remainingPrice);
  }
  if (paiseOnly && priceReversal <= 0) {
    return { reversed: false, engagementsReversed: 0, fullyReversed: true };
  }

  // #1372 — a CREDIT_POOL program meters in paise; LICENSED_SEAT leaves
  // consumedPaise alone (writing a seat count as money would invent a number).
  const reversesPaise = isCreditPool && priceReversal > 0;
  // Each over-cap batch of the sale bumped overageCount once.
  const overageDecrement = willBeFullyReversed ? sale.overCapBatches : 0;

  // Guarded CAS, same shape as the BLOCK branch of the forward path above:
  // the predicate rides the WHERE, so a counter that cannot absorb the
  // reversal matches zero rows rather than being driven negative. This used to
  // be a bare `update` — with no `CHECK (engagementsUsed >= 0)` anywhere in
  // prisma/migrations, a drifted counter (an earlier unguarded writer, a manual fix,
  // a legacy row) turned every refund into a larger giveaway and no database
  // object objected. Each counter is guarded only where this call actually
  // decrements it, so an untouched column cannot fail the match.
  const guard = await tx.programAssignment.updateMany({
    where: {
      id: util.programAssignmentId,
      ...(actualReversal > 0 && { engagementsUsed: { gte: actualReversal } }),
      ...(reversesPaise && { consumedPaise: { gte: priceReversal } }),
      ...(overageDecrement > 0 && {
        overageCount: { gte: overageDecrement },
      }),
    },
    data: {
      engagementsUsed:
        actualReversal > 0 ? { decrement: actualReversal } : undefined,
      // #775/#753 — CREDIT_POOL meters in paise; reverse the prorated price so
      // consumedPaise nets back.
      consumedPaise: reversesPaise ? { decrement: priceReversal } : undefined,
      // Only the last reversal un-counts the sale's over-cap batches.
      overageCount:
        overageDecrement > 0 ? { decrement: overageDecrement } : undefined,
    },
  });
  // Fail closed and loud: the ledger row below is what the reconciler trusts,
  // so writing it against a counter that would have gone negative is how the
  // drift starts. Rolling the transaction back keeps the two in step and
  // surfaces the refund as an error instead of a silent double-restore.
  if (guard.count === 0) {
    throw new ProgramAssignmentUnderflowError(
      util.programAssignmentId,
      actualReversal,
      reversesPaise ? priceReversal : 0,
    );
  }

  await tx.usageLedgerEntry.create({
    data: {
      programAssignmentId: util.programAssignmentId,
      membershipId: util.programAssignment.membershipId,
      paymentId: params.paymentId,
      engagementsConsumed: -actualReversal,
      priceAtBookingPaise: -priceReversal,
      wasOverage: util.wasOverage,
      notes: params.reason ?? "Reversal on refund",
    },
  });

  if (willBeFullyReversed) {
    await tx.bookingUtilization.update({
      where: { paymentId: params.paymentId },
      data: {
        reversedAt: new Date(),
        reversalReason: params.reason ?? "Refund",
      },
    });
    // Every still-uncollected batch overage is no longer owed, and its
    // un-invoiced child accrual is voided; a CHARGED one is credited back by
    // the refund cascade instead.
    if (sale.overCapBatches > 0) {
      await voidReversedOverageAccruals(tx, {
        bookingUtilizationId: util.id,
        parentPaymentId: params.paymentId,
      });
    }
    const reversed = await transitionOverage(
      tx,
      { bookingUtilizationId: util.id },
      "REVERSED",
      undefined,
      { fromIn: ["PENDING", "ACCRUED", "FAILED"] },
    );
    // A reversed member overage no longer owes the base its parent's hold guards.
    if (reversed > 0) {
      await releaseOverageHeldParentEarnings(tx, params.paymentId);
    }
  }

  return {
    reversed: true,
    engagementsReversed: actualReversal,
    fullyReversed: willBeFullyReversed || paiseOnly,
  };
}
