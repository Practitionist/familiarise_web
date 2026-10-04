import { z } from "zod";

import prisma, { type PrismaLike } from "@/lib/prisma";

export const REFERRAL_CONFIG_ID = "singleton";

const configSelect = {
  id: true,
  isActive: true,
  paused: true,
  monthlyBudgetPaise: true,
  currentPeriod: true,
  currentMonthSpentPaise: true,
  referrerRewardPaise: true,
  discountBps: true,
  discountMaxPaise: true,
  redemptionCapBps: true,
  minOrderPaise: true,
  creditExpiryDays: true,
  qualifyWindowDays: true,
  perCodeLifetimeCap: true,
  perReferrerYearlyCapPaise: true,
  weeklyVestCap: true,
  version: true,
  updatedAt: true,
} as const;

/** The programme row, or null before ops has created it (the programme is then off). */
export async function readReferralProgramConfig(db: PrismaLike = prisma) {
  return db.referralProgramConfig.findUnique({
    where: { id: REFERRAL_CONFIG_ID },
    select: configSelect,
  });
}

export type ReferralProgramConfigRow = NonNullable<
  Awaited<ReturnType<typeof readReferralProgramConfig>>
>;

/** The economics as plain JSON, for the ops audit row. */
export function configSnapshot(cfg: {
  paused: boolean;
  monthlyBudgetPaise: number;
  referrerRewardPaise: number;
  discountBps: number;
  discountMaxPaise: number;
  redemptionCapBps: number;
  minOrderPaise: number;
  creditExpiryDays: number;
  qualifyWindowDays: number;
  perCodeLifetimeCap: number;
  perReferrerYearlyCapPaise: number;
  weeklyVestCap: number;
  version: number;
}) {
  return {
    paused: cfg.paused,
    monthlyBudgetPaise: cfg.monthlyBudgetPaise,
    referrerRewardPaise: cfg.referrerRewardPaise,
    discountBps: cfg.discountBps,
    discountMaxPaise: cfg.discountMaxPaise,
    redemptionCapBps: cfg.redemptionCapBps,
    minOrderPaise: cfg.minOrderPaise,
    creditExpiryDays: cfg.creditExpiryDays,
    qualifyWindowDays: cfg.qualifyWindowDays,
    perCodeLifetimeCap: cfg.perCodeLifetimeCap,
    perReferrerYearlyCapPaise: cfg.perReferrerYearlyCapPaise,
    weeklyVestCap: cfg.weeklyVestCap,
    version: cfg.version,
  };
}

/** Live means rewards can be granted: not paused, active, and a budget is set. */
export function isProgramLive(
  cfg: ReferralProgramConfigRow | null,
): cfg is ReferralProgramConfigRow {
  return !!cfg && cfg.isActive && !cfg.paused && cfg.monthlyBudgetPaise > 0;
}

/** The offer as buyers see it; null while the programme is off. */
export function referralTerms(cfg: ReferralProgramConfigRow | null) {
  if (!isProgramLive(cfg)) return null;
  return {
    discountPercent: cfg.discountBps / 100,
    discountMaxPaise: cfg.discountMaxPaise,
    referrerRewardPaise: cfg.referrerRewardPaise,
    minOrderPaise: cfg.minOrderPaise,
  };
}

/** "YYYY-MM" in UTC, the budget window key. */
export function budgetPeriod(now: Date): string {
  return now.toISOString().slice(0, 7);
}

const paise = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bps = z.number().int().min(0).max(10_000);

/** ADMIN edit body; every field optional, at least one present. */
export const referralProgramConfigPatchSchema = z
  .object({
    paused: z.boolean(),
    monthlyBudgetPaise: paise,
    referrerRewardPaise: paise,
    discountBps: bps,
    discountMaxPaise: paise,
    redemptionCapBps: bps,
    minOrderPaise: paise,
    creditExpiryDays: z.number().int().min(1).max(3650),
    qualifyWindowDays: z.number().int().min(1).max(365),
    perCodeLifetimeCap: z.number().int().min(0).max(10_000),
    perReferrerYearlyCapPaise: paise,
    weeklyVestCap: z.number().int().min(0).max(1_000),
  })
  .partial();

export type ReferralProgramConfigPatch = z.infer<
  typeof referralProgramConfigPatchSchema
>;
