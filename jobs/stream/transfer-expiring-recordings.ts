/**
 * Transfer Expiring Recordings Job (GitHub Actions Wrapper)
 *
 * Auto-transfers PERMANENT recordings from Stream S3 to Supabase.
 * Also identifies STREAM_ONLY recordings expiring soon for warnings.
 *
 * Runs every 6 hours via scheduled workflow.
 */

import { RecordingTransferService } from "../../lib/stream/recording-transfer-service";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { withCronLock } from "../../lib/cron/with-cron-lock";
import { notifyRecordingExpiring } from "../../lib/novu/service";
import { getAppUrl } from "../../lib/url";
import { goHref } from "../../lib/dashboard/go";
import fs from "fs";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

// STR-3 — one expiry warning per consultant (count + soonest deadline), so a
// consultant with several expiring STREAM_ONLY recordings isn't spammed.
type ExpiringStreamOnly = {
  recordingId: string;
  title: string;
  consultantUserId: string;
  expiresAt: Date;
};

async function notifyConsultantsOfExpiringRecordings(
  expiring: ExpiringStreamOnly[],
): Promise<void> {
  const byConsultant = new Map<string, ExpiringStreamOnly[]>();
  for (const rec of expiring) {
    if (!rec.consultantUserId) continue;
    const list = byConsultant.get(rec.consultantUserId) ?? [];
    list.push(rec);
    byConsultant.set(rec.consultantUserId, list);
  }

  // #1527 — every recipient here is a consultant.
  const dashboardUrl = `${getAppUrl()}${goHref("expert", "recordings")}`;
  await Promise.allSettled(
    Array.from(byConsultant.entries()).map(([consultantUserId, recs]) => {
      const soonest = recs.reduce(
        (min, r) => (r.expiresAt < min ? r.expiresAt : min),
        recs[0].expiresAt,
      );
      return notifyRecordingExpiring(consultantUserId, {
        recordingCount: recs.length,
        expiresAt: soonest.toISOString(),
        dashboardUrl,
      });
    }),
  );
}

async function main(): Promise<void> {
  await abortIfMaintenance("transfer-expiring-recordings");
  Sentry.logger.info("job:transfer-expiring-recordings started");
  const startTime = Date.now();
  console.log("🚀 Starting transfer-expiring-recordings job...");
  console.log(`   Timestamp: ${new Date().toISOString()}`);

  // #476 — both steps under one entry-level lock; fail-open.
  const { result, expiringStreamOnly } = await withCronLock(
    "transfer-expiring-recordings",
    { failMode: "open" },
    async () => {
      // #899 — 14-day window = every READY permanent recording (Stream URLs
      // live exactly 14d), so the sweep starts transfers near-ready and
      // backstops ready-time webhook kicks that died, not just near-expiry.
      // The batch size is the service's raised default (D7) — do not re-pin it
      // to 10 here; forty transfers a day is what created the permanent
      // backlog this sweep is supposed to clear.
      const result = await RecordingTransferService.processExpiringRecordings(
        14,
        undefined,
        "PERMANENT",
      );

      // Find STREAM_ONLY recordings expiring in 3 days (for warnings)
      const expiringStreamOnly =
        await RecordingTransferService.getExpiringStreamOnlyRecordings(3);
      return { result, expiringStreamOnly };
    },
  );

  // STR-3 — warn consultants whose STREAM_ONLY recordings are about to expire.
  if (expiringStreamOnly.length > 0) {
    await notifyConsultantsOfExpiringRecordings(expiringStreamOnly);
  }

  // #899 — backlog alert: permanent recordings <72h from Stream expiry that
  // this sweep still left untransferred. Non-zero means the pipeline is
  // falling behind or failing repeatedly; page before the bytes lapse.
  //
  // D7 — escalated from `warning` to `error`, and that is the substantive half
  // of this fix. The per-recording failure page goes through
  // `recordSystemError`, which writes a SystemEvent row; this one was a bare
  // Sentry `captureMessage` at `warning`, which is filtered out of the paging
  // path an on-call human actually watches. So a recording that had already
  // failed its first attempt — nowhere near the >=3 attempt threshold — and was
  // then overtaken by the expiry clock produced NO alert at all. That is the
  // exact failure the alert was added for (#899) and the level is why it never
  // fired. A permanent recording inside 72h of losing its bytes is a page, not
  // a warning.
  const atRisk =
    await RecordingTransferService.countAtRiskPermanentRecordings(72);
  if (atRisk > 0) {
    console.warn(
      `⚠️ ${atRisk} permanent recording(s) <72h from Stream expiry, still untransferred`,
    );
    Sentry.captureMessage("Permanent recordings at risk of Stream URL expiry", {
      level: "error",
      tags: { subsystem: "jobs", job: "transfer-expiring-recordings" },
      extra: { atRisk },
    });
  }

  const duration = (Date.now() - startTime) / 1000;
  console.log(`\n⏱️ Job completed in ${duration.toFixed(2)} seconds`);
  console.log(`   Transferred: ${result.succeeded}`);
  console.log(`   Failed: ${result.failed}`);
  // D7 — reported separately from `Failed` because it is not a failure: the
  // retention sweep or the expiry sweep retired these rows while the batch held
  // them, and counting them as failures would make a healthy run exit non-zero.
  console.log(`   Retired mid-transfer: ${result.retired}`);
  console.log(`   STREAM_ONLY expiring soon: ${expiringStreamOnly.length}`);

  if (result.errors.length > 0) {
    console.warn("   Errors:", result.errors.join("; "));
  }

  if (process.env.GITHUB_ACTIONS && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_ACTIONS && process.env.GITHUB_OUTPUT,
      `transferred=${result.succeeded}\nfailed=${result.failed}\nretired=${result.retired}\nexpiring_stream_only=${expiringStreamOnly.length}\nsuccess=true\n`,
    );
  }

  Sentry.logger.info("job:transfer-expiring-recordings finished", {
    succeeded: result.succeeded,
    failed: result.failed,
    retired: result.retired,
    expiringStreamOnly: expiringStreamOnly.length,
    atRisk,
  });

  if (result.failed > 0) {
    console.warn("⚠️ Some transfers failed");
    process.exitCode = 1;
    return;
  }

  console.log("🎉 Job completed successfully");
}

runJob("transfer-expiring-recordings", main);
