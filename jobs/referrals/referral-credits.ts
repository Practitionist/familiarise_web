/**
 * Referral credit lifecycle jobs: the 15-minute vest sweep (ticker slug
 * `vest-referral-credits`) and the monthly breakage step (Actions slug
 * `expire-referral-credits`, which is what `main` runs).
 */
import * as Sentry from "@sentry/nextjs";

import prisma from "@/lib/prisma";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { reportSentryMessage } from "@/lib/observability/report";
import { runJob } from "@/lib/observability/job-sentry";
import {
  expireReferralCredits,
  vestQualifyingReferrals,
  type BreakageRunResult,
  type VestRunResult,
} from "@/lib/referrals/vesting";

export async function runVestReferralCredits(opts: {
  limit: number;
}): Promise<VestRunResult> {
  return withCronLock(
    "vest-referral-credits",
    { failMode: "closed" },
    async () => {
      const result = await vestQualifyingReferrals({
        limit: opts.limit,
      });
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

export async function runExpireReferralCredits(): Promise<BreakageRunResult> {
  return withCronLock(
    "expire-referral-credits",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    async () => {
      const result = await expireReferralCredits({
        batchSize: 200,
        maxBatches: 50,
      });
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

async function main(): Promise<void> {
  await abortIfMaintenance("expire-referral-credits");
  Sentry.logger.info("job:expire-referral-credits started");
  const r = await runExpireReferralCredits();
  console.log(
    `[expire-referral-credits] expired=${r.expired} breakagePaise=${r.breakagePaise} failed=${r.failed}`,
  );
  Sentry.logger.info("job:expire-referral-credits finished", {
    expired: r.expired,
    breakagePaise: r.breakagePaise,
    failed: r.failed,
  });
}

if (require.main === module) {
  runJob("expire-referral-credits", () =>
    main().finally(() => prisma.$disconnect()),
  );
}
