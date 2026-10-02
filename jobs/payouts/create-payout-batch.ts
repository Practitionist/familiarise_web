/**
 * Create Payout Batch Job (GitHub Actions Version)
 *
 * Drives the canonical `lib/payments/payouts` service (which acquires
 * `lock:payout_batch_creation` and computes MSME `mustPayByDate`) and also
 * creates weekly organization payout batches via `createOrgPayoutBatches`.
 *
 * Runs weekly on Mondays at 8:00 PM UTC (1:30 AM IST next day).
 */

import fs from "fs";
import * as Sentry from "@sentry/nextjs";
import prisma from "../../lib/prisma";
import {
  createPayoutBatch,
  createOrgPayoutBatches,
} from "../../lib/payments/payouts";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { runJob } from "../../lib/observability/job-sentry";

async function main(): Promise<void> {
  await abortIfMaintenance("create-payout-batch");
  Sentry.logger.info("job:create-payout-batch started");
  const startTime = Date.now();
  console.log(
    `🚀 Starting payout batch creation job at ${new Date().toISOString()}`,
  );

  try {
    const batchId = await createPayoutBatch();
    const orgBatch = await createOrgPayoutBatches();

    const duration = (Date.now() - startTime) / 1000;
    console.log(`⏱️ Job completed in ${duration.toFixed(2)} seconds`);
    console.log(`   📦 Consultant Batch ID: ${batchId || "none"}`);
    console.log(
      `   🏢 Org Payouts Created: ${orgBatch.payoutsCreated} (scanned ${orgBatch.orgsScanned})`,
    );

    if (process.env.GITHUB_ACTIONS && process.env.GITHUB_OUTPUT) {
      const outputs = [
        `batch_id=${batchId}`,
        `org_payouts_created=${orgBatch.payoutsCreated}`,
        `success=true`,
      ].join("\n");
      fs.appendFileSync(process.env.GITHUB_OUTPUT, outputs + "\n");
    }

    Sentry.logger.info("job:create-payout-batch finished", {
      batchId,
      orgPayoutsCreated: orgBatch.payoutsCreated,
      orgsScanned: orgBatch.orgsScanned,
    });
  } finally {
    await prisma.$disconnect();
  }
}

runJob("create-payout-batch", main);
