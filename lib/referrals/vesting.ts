import type { AppointmentsType, Prisma } from "@prisma/client";
import { z } from "zod";

import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { LONG_JOB_TTL_MS, withCronLock } from "@/lib/cron/with-cron-lock";
import { reportSentryMessage } from "@/lib/observability/report";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
import { holdHoursFor } from "@/lib/payments/payouts/earnings-hold";
import {
  firstLiveOccurrenceId,
  UNDELIVERED_OCCURRENCE_STATUSES,
} from "./capture";
import {
  isProgramLive,
  readReferralProgramConfig,
  REFERRAL_CONFIG_ID,
  rollBudgetPeriod,
  type ReferralProgramConfigRow,
} from "./program-config";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** A sweep stops starting rows after this, inside the ticker's 20 s target budget. */
const RUN_DEADLINE_MS = 12_000;

export type ReferralVoidReason =
  | "REFUNDED"
  | "CHARGEBACK"
  | "SESSION_NOT_DELIVERED"
  | "WINDOW_LAPSED"
  | "SELF_DEALING"
  | "CODE_CAP_REACHED"
  | "REFERRER_YEARLY_CAP"
  | "KYC_NOT_COMPLETED"
  | "MISSING_CREDIT"
  | "NO_EXPERT_PROFILE";

export type VestOutcome =
  | "VESTED"
  | "VOIDED"
  | "REOPENED"
  | "DEFERRED"
  | "BUDGET_EXHAUSTED"
  | "SKIPPED";

/** A predicate re-checked in a CAS no longer held; the whole row rolls back and retries next run. */
class VestRaced extends Error {
  constructor(step: string) {
    super(`referral vest raced at ${step}`);
    this.name = "VestRaced";
  }
}

/** The month's budget cannot cover this reward; the row rolls back and waits for the next window. */
class BudgetExhausted extends Error {
  constructor() {
    super("referral budget exhausted");
    this.name = "BudgetExhausted";
  }
}

/** Refunds that block a vest; any SUCCEEDED one voids it. */
const BLOCKING_REFUND_STATUSES = ["PENDING", "SUCCEEDED"] as const;
/** Disputes that no longer threaten the payment. */
const SETTLED_DISPUTE_STATUSES = ["WON", "CLOSED", "WARNING_CLOSED"] as const;
const LOST_DISPUTE_STATUSES = ["LOST", "CHARGE_REFUNDED"] as const;

function holdHoursForAppointment(type: AppointmentsType): number {
  return type === "TRIAL" ? holdHoursFor("CONSULTATION") : holdHoursFor(type);
}

const referralForVest = {
  id: true,
  status: true,
  referredUserId: true,
  qualifiedAt: true,
  referralCodeId: true,
  referralCode: {
    select: {
      userId: true,
      user: { select: { consultantProfile: { select: { id: true } } } },
    },
  },
  referredUser: {
    select: {
      consultantProfile: {
        select: {
          id: true,
          taxInfo: { select: { panLast4: true } },
          payoutAccounts: {
            where: { isDefault: true },
            select: { isVerified: true },
          },
        },
      },
    },
  },
  qualifyingPayment: {
    select: {
      id: true,
      userId: true,
      appointmentId: true,
      appointment: { select: { appointmentType: true } },
      refunds: { select: { status: true, metadata: true } },
      disputes: { select: { status: true } },
      earnings: {
        where: { role: "OWNER" },
        select: { consultantProfile: { select: { userId: true } } },
        take: 1,
      },
    },
  },
  qualifyingOccurrence: {
    select: { id: true, completionStatus: true, endsAt: true, deletedAt: true },
  },
} satisfies Prisma.ReferralSelect;

type VestReferral = Prisma.ReferralGetPayload<{
  select: typeof referralForVest;
}>;

async function voidReferral(
  tx: Tx,
  referralId: string,
  reason: ReferralVoidReason,
  now: Date,
): Promise<VestOutcome> {
  const moved = await tx.referral.updateMany({
    where: { id: referralId, status: "QUALIFYING" },
    data: { status: "VOID", voidReason: reason },
  });
  if (moved.count === 0) return "SKIPPED";
  await tx.referralCredit.updateMany({
    where: { referralId, state: "PENDING" },
    data: { state: "VOID", voidedAt: now },
  });
  return "VOIDED";
}

/** Who asked for a refund, as the refund paths record it; null is an automated sweep. */
const refundInitiatorSchema = z.object({
  initiatedByUserId: z.string().nullable(),
});

/** A succeeded refund the buyer asked for, or one whose initiator was never recorded. */
function buyerCancelled(
  refunds: { status: string; metadata: Prisma.JsonValue }[],
  buyerUserId: string,
): boolean {
  return refunds.some((x) => {
    if (x.status !== "SUCCEEDED") return false;
    const meta = refundInitiatorSchema.safeParse(x.metadata);
    return !meta.success || meta.data.initiatedByUserId === buyerUserId;
  });
}

/**
 * The expert or the platform cancelled the referee's qualifying order: the referral goes
 * back to SIGNED_UP inside its original window, the referrer's PENDING credit is voided, and
 * the order stops counting as the first purchase or holding the welcome-discount slot.
 */
async function reopenReferral(
  tx: Tx,
  referralId: string,
  paymentId: string,
  now: Date,
): Promise<VestOutcome> {
  const moved = await tx.referral.updateMany({
    where: {
      id: referralId,
      status: "QUALIFYING",
      qualifyingPaymentId: paymentId,
    },
    data: {
      status: "SIGNED_UP",
      qualifyingPaymentId: null,
      qualifyingOccurrenceId: null,
      qualifiedAt: null,
      qualifyingAction: null,
    },
  });
  if (moved.count === 0) return "SKIPPED";
  await tx.referralCredit.updateMany({
    where: { referralId, state: "PENDING" },
    data: { state: "VOID", voidedAt: now },
  });
  await tx.payment.updateMany({
    where: { id: paymentId, referralReleasedAt: null },
    data: { referralReleasedAt: now },
  });
  await tx.expertCustomerRelationship.deleteMany({
    where: { firstPaymentId: paymentId, source: "CONSUMER_REFERRAL" },
  });
  return "REOPENED";
}

/** The predicates the vest CAS repeats against committed rows. */
function vestableWhere(
  referralId: string,
  occurrenceId: string,
  deliveredBefore: Date,
): Prisma.ReferralWhereInput {
  return {
    id: referralId,
    status: "QUALIFYING",
    qualifyingOccurrenceId: occurrenceId,
    qualifyingOccurrence: {
      completionStatus: "COMPLETED",
      deletedAt: null,
      endsAt: { lte: deliveredBefore },
    },
    qualifyingPayment: {
      refunds: { none: { status: { in: [...BLOCKING_REFUND_STATUSES] } } },
      disputes: {
        none: { status: { notIn: [...SETTLED_DISPUTE_STATUSES] } },
      },
    },
  };
}

type Delivered =
  | { kind: "ready"; occurrenceId: string; deliveredBefore: Date; endsAt: Date }
  | { kind: "wait" }
  | { kind: "refunded"; paymentId: string; byBuyer: boolean }
  | { kind: "void"; reason: ReferralVoidReason };

/** Refund, dispute and delivery state of the qualifying purchase. */
async function deliveryState(
  tx: Tx,
  r: VestReferral,
  cfg: ReferralProgramConfigRow,
  now: Date,
): Promise<Delivered> {
  const pay = r.qualifyingPayment;
  if (!pay) return { kind: "void", reason: "REFUNDED" };
  if (pay.refunds.some((x) => x.status === "SUCCEEDED")) {
    return {
      kind: "refunded",
      paymentId: pay.id,
      byBuyer: buyerCancelled(pay.refunds, pay.userId),
    };
  }
  if (
    pay.disputes.some((d) =>
      LOST_DISPUTE_STATUSES.some((lost) => lost === d.status),
    )
  ) {
    return { kind: "void", reason: "CHARGEBACK" };
  }
  const windowMs = cfg.qualifyWindowDays * DAY_MS;

  let occ = r.qualifyingOccurrence;
  if (!occ || occ.deletedAt || occ.completionStatus === "RESCHEDULED") {
    const nextId = await firstLiveOccurrenceId(tx, pay.appointmentId);
    occ = nextId
      ? await tx.appointmentOccurrence.findUnique({
          where: { id: nextId },
          select: {
            id: true,
            completionStatus: true,
            endsAt: true,
            deletedAt: true,
          },
        })
      : null;
    if (!occ) {
      const since = r.qualifiedAt?.getTime() ?? now.getTime();
      return now.getTime() - since > windowMs
        ? { kind: "void", reason: "WINDOW_LAPSED" }
        : { kind: "wait" };
    }
    await tx.referral.updateMany({
      where: { id: r.id, status: "QUALIFYING" },
      data: { qualifyingOccurrenceId: occ.id },
    });
  }
  if (UNDELIVERED_OCCURRENCE_STATUSES.some((s) => s === occ.completionStatus)) {
    return { kind: "void", reason: "SESSION_NOT_DELIVERED" };
  }
  if (occ.completionStatus !== "COMPLETED") {
    return now.getTime() - occ.endsAt.getTime() > windowMs
      ? { kind: "void", reason: "WINDOW_LAPSED" }
      : { kind: "wait" };
  }
  const blocked =
    pay.refunds.some((x) => x.status === "PENDING") ||
    pay.disputes.some(
      (d) => !SETTLED_DISPUTE_STATUSES.some((ok) => ok === d.status),
    );
  const type = pay.appointment?.appointmentType ?? "CONSULTATION";
  const deliveredBefore = new Date(
    now.getTime() - holdHoursForAppointment(type) * HOUR_MS,
  );
  if (blocked || occ.endsAt > deliveredBefore) return { kind: "wait" };
  return {
    kind: "ready",
    occurrenceId: occ.id,
    deliveredBefore,
    endsAt: occ.endsAt,
  };
}

/** Spend `amount` of this month's budget by conditional update; false when it would overrun. */
async function claimBudget(
  tx: Tx,
  cfg: ReferralProgramConfigRow,
  amount: number,
  now: Date,
): Promise<boolean> {
  const period = await rollBudgetPeriod(tx, now);
  if (amount > cfg.monthlyBudgetPaise) return false;
  const claimed = await tx.referralProgramConfig.updateMany({
    where: {
      id: REFERRAL_CONFIG_ID,
      version: cfg.version,
      isActive: true,
      paused: false,
      currentPeriod: period,
      currentMonthSpentPaise: { lte: cfg.monthlyBudgetPaise - amount },
    },
    data: { currentMonthSpentPaise: { increment: amount } },
  });
  return claimed.count === 1;
}

/** UTC calendar-year and ISO-week (Monday) keys for the per-referrer vest counters. */
function capKeys(now: Date): { year: string; week: string } {
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return {
    year: now.toISOString().slice(0, 4),
    week: monday.toISOString().slice(0, 10),
  };
}

/** Starts the code's year and week counters afresh when their keys are stale. */
async function rollCapPeriods(
  tx: Tx,
  referralCodeId: string,
  keys: { year: string; week: string },
): Promise<void> {
  await tx.referralCode.updateMany({
    where: { id: referralCodeId, capYear: { not: keys.year } },
    data: { capYear: keys.year, yearRewardPaise: 0, yearExpertVests: 0 },
  });
  await tx.referralCode.updateMany({
    where: { id: referralCodeId, capWeek: { not: keys.week } },
    data: { capWeek: keys.week, weekVests: 0 },
  });
}

/** Which cap refused the slot: the lifetime and yearly caps void, the weekly one waits. */
async function capRefusal(
  tx: Tx,
  r: VestReferral,
  cfg: ReferralProgramConfigRow,
  reward: number,
  now: Date,
): Promise<VestOutcome> {
  const code = await tx.referralCode.findUnique({
    where: { id: r.referralCodeId },
    select: { successfulReferrals: true, yearRewardPaise: true },
  });
  if (!code || code.successfulReferrals >= cfg.perCodeLifetimeCap) {
    return voidReferral(tx, r.id, "CODE_CAP_REACHED", now);
  }
  if (code.yearRewardPaise + reward > cfg.perReferrerYearlyCapPaise) {
    return voidReferral(tx, r.id, "REFERRER_YEARLY_CAP", now);
  }
  return "DEFERRED";
}

async function vestConsumerReferral(
  tx: Tx,
  r: VestReferral,
  cfg: ReferralProgramConfigRow,
  ready: { occurrenceId: string; deliveredBefore: Date; endsAt: Date },
  now: Date,
): Promise<VestOutcome> {
  const referrerUserId = r.referralCode.userId;
  const credit = await tx.referralCredit.findFirst({
    where: {
      referralId: r.id,
      userId: referrerUserId,
      source: "REFERRAL_BONUS",
      state: "PENDING",
    },
    select: { id: true, amount: true },
  });
  if (!credit) return voidReferral(tx, r.id, "MISSING_CREDIT", now);
  const reward = credit.amount;

  // Lifetime, yearly and weekly caps in one conditional update on the code row.
  const keys = capKeys(now);
  await rollCapPeriods(tx, r.referralCodeId, keys);
  const codeSlot = await tx.referralCode.updateMany({
    where: {
      id: r.referralCodeId,
      capYear: keys.year,
      capWeek: keys.week,
      successfulReferrals: { lt: cfg.perCodeLifetimeCap },
      yearRewardPaise: { lte: cfg.perReferrerYearlyCapPaise - reward },
      weekVests: { lt: cfg.weeklyVestCap },
    },
    data: {
      successfulReferrals: { increment: 1 },
      totalEarned: { increment: reward },
      yearRewardPaise: { increment: reward },
      weekVests: { increment: 1 },
    },
  });
  if (codeSlot.count === 0) return capRefusal(tx, r, cfg, reward, now);
  if (!(await claimBudget(tx, cfg, reward, now))) throw new BudgetExhausted();

  const vested = await tx.referral.updateMany({
    where: vestableWhere(r.id, ready.occurrenceId, ready.deliveredBefore),
    data: { status: "VESTED", vestedAt: now, referrerRewardPaidAt: now },
  });
  if (vested.count === 0) throw new VestRaced("referral");
  const creditMoved = await tx.referralCredit.updateMany({
    where: { id: credit.id, state: "PENDING" },
    data: {
      state: "VESTED",
      vestedAt: now,
      expiresAt: new Date(now.getTime() + cfg.creditExpiryDays * DAY_MS),
    },
  });
  if (creditMoved.count === 0) throw new VestRaced("credit");

  await postLedgerTxn(tx, {
    idempotencyKey: `referral-vest:${credit.id}`,
    kind: "REFERRAL_CREDIT",
    description: `Referral credit vested for referral ${r.id}`,
    postings: [
      {
        account: { kind: "PLATFORM_PROMO" },
        direction: "DEBIT",
        amountPaise: reward,
      },
      {
        account: { kind: "REFERRAL_CREDIT_LIABILITY" },
        direction: "CREDIT",
        amountPaise: reward,
      },
    ],
  });
  return "VESTED";
}

async function vestExpertReferral(
  tx: Tx,
  r: VestReferral,
  cfg: ReferralProgramConfigRow,
  ready: { occurrenceId: string; deliveredBefore: Date; endsAt: Date },
  now: Date,
): Promise<VestOutcome> {
  const referee = r.referredUser.consultantProfile;
  if (!referee) return voidReferral(tx, r.id, "NO_EXPERT_PROFILE", now);
  const kycDone =
    !!referee.taxInfo?.panLast4 &&
    referee.payoutAccounts.some((a) => a.isVerified);
  if (!kycDone) {
    const lapsed =
      now.getTime() - ready.endsAt.getTime() > cfg.qualifyWindowDays * DAY_MS;
    return lapsed
      ? voidReferral(tx, r.id, "KYC_NOT_COMPLETED", now)
      : "DEFERRED";
  }

  const keys = capKeys(now);
  await rollCapPeriods(tx, r.referralCodeId, keys);
  const codeSlot = await tx.referralCode.updateMany({
    where: {
      id: r.referralCodeId,
      capYear: keys.year,
      yearExpertVests: { lt: cfg.expertYearlyReferralCap },
    },
    data: {
      successfulReferrals: { increment: 1 },
      yearExpertVests: { increment: 1 },
    },
  });
  if (codeSlot.count === 0) {
    return voidReferral(tx, r.id, "REFERRER_YEARLY_CAP", now);
  }
  if (!(await claimBudget(tx, cfg, cfg.expertReferralBudgetPaise, now))) {
    throw new BudgetExhausted();
  }

  const vested = await tx.referral.updateMany({
    where: vestableWhere(r.id, ready.occurrenceId, ready.deliveredBefore),
    data: { status: "VESTED", vestedAt: now, referrerRewardPaidAt: now },
  });
  if (vested.count === 0) throw new VestRaced("referral");

  const expiresAt = new Date(now.getTime() + cfg.expertWaiverDays * DAY_MS);
  const referrerProfileId = r.referralCode.user.consultantProfile?.id;
  await tx.consultantFeeWaiver.createMany({
    data: [
      {
        consultantProfileId: referee.id,
        reason: "REFERRED_EXPERT" as const,
        sessionsRemaining: cfg.expertWaiverSessions,
        expiresAt,
        referralId: r.id,
      },
      ...(referrerProfileId
        ? [
            {
              consultantProfileId: referrerProfileId,
              reason: "REFERRING_EXPERT" as const,
              sessionsRemaining: cfg.expertWaiverSessions,
              expiresAt,
              referralId: r.id,
            },
          ]
        : []),
    ],
    skipDuplicates: true,
  });
  return "VESTED";
}

/** One QUALIFYING referral → VESTED, VOID, or left for a later run. */
export async function settleQualifyingReferral(
  referralId: string,
  now: Date = new Date(),
): Promise<VestOutcome> {
  try {
    return await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const r = await tx.referral.findUnique({
            where: { id: referralId },
            select: referralForVest,
          });
          if (r?.status !== "QUALIFYING") return "SKIPPED";
          const cfg = await readReferralProgramConfig(tx);
          if (!cfg) return "DEFERRED";
          const state = await deliveryState(tx, r, cfg, now);
          const pay = r.qualifyingPayment;
          const isExpertReferral = !!pay && pay.userId !== r.referredUserId;
          if (state.kind === "refunded") {
            return isExpertReferral || state.byBuyer
              ? voidReferral(tx, r.id, "REFUNDED", now)
              : reopenReferral(tx, r.id, state.paymentId, now);
          }
          if (state.kind === "void") {
            return voidReferral(tx, r.id, state.reason, now);
          }

          const sellerUserId = pay?.earnings[0]?.consultantProfile.userId;
          const referrerUserId = r.referralCode.userId;
          if (
            isExpertReferral
              ? pay.userId === referrerUserId
              : sellerUserId === referrerUserId
          ) {
            return voidReferral(tx, r.id, "SELF_DEALING", now);
          }
          if (state.kind === "wait" || !isProgramLive(cfg)) return "DEFERRED";
          return isExpertReferral
            ? vestExpertReferral(tx, r, cfg, state, now)
            : vestConsumerReferral(tx, r, cfg, state, now);
        },
        { isolationLevel: "Serializable", timeout: 15_000 },
      ),
    );
  } catch (err) {
    if (err instanceof VestRaced) return "DEFERRED";
    if (err instanceof BudgetExhausted) return "BUDGET_EXHAUSTED";
    throw err;
  }
}

export interface VestRunResult {
  scanned: number;
  vested: number;
  voided: number;
  deferred: number;
  budgetExhausted: number;
  failed: number;
  failures: { referralId: string; error: string }[];
}

/** The ticker sweep: least recently examined QUALIFYING first, one transaction per referral. */
export async function vestQualifyingReferrals(opts: {
  limit: number;
  now?: Date;
}): Promise<VestRunResult> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const rows = await prisma.referral.findMany({
    where: { status: "QUALIFYING" },
    orderBy: { updatedAt: "asc" },
    take: opts.limit,
    select: { id: true },
  });
  const result: VestRunResult = {
    scanned: 0,
    vested: 0,
    voided: 0,
    deferred: 0,
    budgetExhausted: 0,
    failed: 0,
    failures: [],
  };
  for (const { id } of rows) {
    if (Date.now() - started > RUN_DEADLINE_MS) break;
    result.scanned++;
    try {
      const outcome = await settleQualifyingReferral(id, now);
      if (outcome === "VESTED") result.vested++;
      else if (outcome === "VOIDED" || outcome === "REOPENED") result.voided++;
      else if (outcome === "DEFERRED" || outcome === "BUDGET_EXHAUSTED") {
        if (outcome === "DEFERRED") result.deferred++;
        else result.budgetExhausted++;
        // Rotate it behind rows not yet examined so waiting referrals never starve ready ones.
        await prisma.referral.updateMany({
          where: { id, status: "QUALIFYING" },
          data: { updatedAt: now },
        });
      }
    } catch (err) {
      result.failed++;
      result.failures.push({
        referralId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/** The `vest-referral-credits` registry job; failures are reported once per run. */
export async function runVestReferralCredits(opts: {
  limit: number;
}): Promise<VestRunResult> {
  return withCronLock(
    "vest-referral-credits",
    { failMode: "closed" },
    async () => {
      const result = await vestQualifyingReferrals({ limit: opts.limit });
      if (result.failed > 0) {
        reportSentryMessage("REFERRAL_VEST_FAILURES", {
          subsystem: "referrals",
          level: "warning",
          extra: {
            failed: result.failed,
            failures: result.failures.slice(0, 20),
          },
        });
      }
      return result;
    },
  );
}

export interface BreakageRunResult {
  expired: number;
  breakagePaise: number;
  failed: number;
  failures: { creditId: string; error: string }[];
}

/**
 * The monthly breakage step: up to `limit` VESTED credits past their expiry become EXPIRED,
 * and a balance with `vestedAt` set is released from the liability back to PLATFORM_PROMO.
 */
export async function expireReferralCredits(opts: {
  limit: number;
  now?: Date;
}): Promise<BreakageRunResult> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const result: BreakageRunResult = {
    expired: 0,
    breakagePaise: 0,
    failed: 0,
    failures: [],
  };
  const failedIds = new Set<string>();
  let examined = 0;
  while (examined < opts.limit && Date.now() - started <= RUN_DEADLINE_MS) {
    const rows = await prisma.referralCredit.findMany({
      where: {
        state: "VESTED",
        expiresAt: { lt: now },
        id: { notIn: [...failedIds] },
      },
      orderBy: { expiresAt: "asc" },
      take: Math.min(200, opts.limit - examined),
      select: { id: true },
    });
    if (rows.length === 0) break;
    for (const { id } of rows) {
      if (Date.now() - started > RUN_DEADLINE_MS) break;
      examined++;
      try {
        const released = await withSerializableRetry(() =>
          prisma.$transaction((tx) => expireOneCredit(tx, id, now), {
            isolationLevel: "Serializable",
          }),
        );
        if (released !== null) {
          result.expired++;
          result.breakagePaise += released;
        }
      } catch (err) {
        failedIds.add(id);
        result.failed++;
        result.failures.push({
          creditId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return result;
}

/** The `expire-referral-credits` registry job; failures are reported once per run. */
export async function runExpireReferralCredits(opts: {
  limit: number;
}): Promise<BreakageRunResult> {
  return withCronLock(
    "expire-referral-credits",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    async () => {
      const result = await expireReferralCredits({ limit: opts.limit });
      if (result.failed > 0) {
        reportSentryMessage("REFERRAL_BREAKAGE_FAILURES", {
          subsystem: "referrals",
          level: "warning",
          extra: {
            failed: result.failed,
            failures: result.failures.slice(0, 20),
          },
        });
      }
      return result;
    },
  );
}

/** Null when the credit already moved; otherwise the paise released as breakage. */
async function expireOneCredit(
  tx: Tx,
  creditId: string,
  now: Date,
): Promise<number | null> {
  const credit = await tx.referralCredit.findUnique({
    where: { id: creditId },
    select: {
      state: true,
      expiresAt: true,
      remainingAmount: true,
      usedAmount: true,
      vestedAt: true,
    },
  });
  if (credit?.state !== "VESTED" || !credit.expiresAt) return null;
  if (credit.expiresAt >= now) return null;
  const moved = await tx.referralCredit.updateMany({
    where: {
      id: creditId,
      state: "VESTED",
      remainingAmount: credit.remainingAmount,
      usedAmount: credit.usedAmount,
    },
    data: { state: "EXPIRED" },
  });
  if (moved.count === 0) return null;
  if (!credit.vestedAt || credit.remainingAmount <= 0) return 0;
  await postLedgerTxn(tx, {
    idempotencyKey: `referral-breakage:${creditId}`,
    kind: "REFERRAL_CREDIT",
    description: `Referral credit ${creditId} expired unredeemed`,
    postings: [
      {
        account: { kind: "REFERRAL_CREDIT_LIABILITY" },
        direction: "DEBIT",
        amountPaise: credit.remainingAmount,
      },
      {
        account: { kind: "PLATFORM_PROMO" },
        direction: "CREDIT",
        amountPaise: credit.remainingAmount,
      },
    ],
  });
  return credit.remainingAmount;
}
