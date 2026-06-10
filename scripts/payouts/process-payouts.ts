#!/usr/bin/env node

/**
 * Process Payouts Script
 *
 * Processes all approved payouts via RazorpayX or Stripe Connect.
 * Sends money to consultant bank accounts/UPI/Stripe accounts.
 *
 * This module exports functions that can be used by:
 * - Local development: `npm run scripts:process-payouts`
 * - GitHub Actions: `jobs/process-payouts.ts`
 * - API routes: Can import and call functions directly
 *
 * Schedule: Runs weekly on Mondays at 2:30 AM IST (9:00 PM UTC Sunday)
 */

import { PayoutStatus, PaymentGateway } from "@prisma/client";
import prisma from "@/lib/prisma";
import { processOrgPayout } from "@/lib/payments/payouts/org-payout-service";
import { sumPaise } from "@/lib/payments/utils/money";

/**
 * Result structure for individual payout processing
 */
export interface PayoutProcessResult {
  payoutId: string;
  success: boolean;
  providerPayoutId?: string;
  error?: string;
  /** #776 — true when another concurrent run already claimed this payout. */
  skipped?: boolean;
}

/**
 * Result structure for batch processing
 */
export interface ProcessingResult {
  success: boolean;
  processed: number;
  succeeded: number;
  failed: number;
  results: PayoutProcessResult[];
  errors: string[];
}

/**
 * RazorpayX Payouts Service (simplified for script)
 */
async function createRazorpayPayout(
  fundAccountId: string,
  amount: number,
  currency: string,
  payoutId: string,
): Promise<{ id: string }> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error("RazorpayX credentials not configured");
  }

  const accountNumber = process.env.RAZORPAYX_ACCOUNT_NUMBER;
  if (!accountNumber) {
    throw new Error("RazorpayX account number not configured");
  }

  const response = await fetch("https://api.razorpay.com/v1/payouts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      // Deterministic key — must match across retries so RazorpayX dedupes
      // re-submissions of the same payout (#enterprise close-out 2026-05-15).
      // Previously included `Date.now()`, which defeated dedupe and risked
      // double payouts when the network round-trip retried.
      "X-Payout-Idempotency": `payout_${payoutId}`,
    },
    body: JSON.stringify({
      account_number: accountNumber,
      fund_account_id: fundAccountId,
      amount,
      currency,
      mode: amount >= 20000000 ? "NEFT" : "IMPS", // NEFT for >= 2 lakh
      purpose: "payout",
      queue_if_low_balance: true,
      reference_id: payoutId,
      narration: "Familiarise consultant payout",
      notes: {
        payoutId,
        source: "familiarise_platform",
      },
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`RazorpayX API error: ${JSON.stringify(error)}`);
  }

  return response.json();
}

/**
 * Stripe Connect Transfer (simplified for script)
 */
async function createStripeTransfer(
  connectedAccountId: string,
  amount: number,
  currency: string,
  payoutId: string,
): Promise<{ id: string }> {
  const Stripe = (await import("stripe")).default;
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

  if (!stripeSecretKey) {
    throw new Error("Stripe credentials not configured");
  }

  const stripe = new Stripe(stripeSecretKey);

  const transfer = await stripe.transfers.create(
    {
      amount,
      currency: currency.toLowerCase(),
      destination: connectedAccountId,
      description: `Payout ${payoutId}`,
      metadata: {
        payoutId,
        source: "familiarise_platform",
      },
    },
    {
      idempotencyKey: `transfer_${payoutId}`,
    },
  );

  return { id: transfer.id };
}

/**
 * Process a single payout
 */
async function processSinglePayout(payout: {
  id: string;
  provider: PaymentGateway;
  amount: number;
  currency: string;
  consultantProfile: {
    payoutAccounts: Array<{
      razorpayFundAccId: string | null;
      stripeAccountId: string | null;
      accountType: string;
    }>;
  };
}): Promise<PayoutProcessResult> {
  const result: PayoutProcessResult = {
    payoutId: payout.id,
    success: false,
  };

  // #785 — declared OUTSIDE the try so the catch can read it: undefined until the
  // gateway accepts, letting the catch tell a pre-gateway failure (safe to FAIL +
  // release earnings) from a post-gateway DB-write failure (money already sent).
  let providerPayoutId: string | undefined;

  try {
    // #776 — atomically claim APPROVED→PROCESSING. Two overlapping cron runs both
    // load the same APPROVED set; without this guard both submit to the gateway.
    // The gateway dedupes on the @unique idempotencyKey, but the loser's
    // duplicate-submit error would be caught below and mark the payout FAILED — a
    // false failure plus retry churn. count===0 means another run already claimed
    // it, so we skip submission entirely.
    const claim = await prisma.consultantPayout.updateMany({
      where: { id: payout.id, status: PayoutStatus.APPROVED },
      data: { status: PayoutStatus.PROCESSING },
    });
    if (claim.count === 0) {
      console.log(
        `⏭️  Payout ${payout.id} already claimed by another run — skipping`,
      );
      result.skipped = true;
      return result;
    }

    const account = payout.consultantProfile.payoutAccounts[0];
    if (!account) {
      throw new Error("No payout account found");
    }

    if (payout.provider === PaymentGateway.RAZORPAY) {
      if (!account.razorpayFundAccId) {
        throw new Error("Razorpay fund account not found");
      }

      const rpPayout = await createRazorpayPayout(
        account.razorpayFundAccId,
        payout.amount,
        payout.currency,
        payout.id,
      );
      providerPayoutId = rpPayout.id;
    } else if (payout.provider === PaymentGateway.STRIPE) {
      if (!account.stripeAccountId) {
        throw new Error("Stripe connected account not found");
      }

      const transfer = await createStripeTransfer(
        account.stripeAccountId,
        payout.amount,
        payout.currency,
        payout.id,
      );
      providerPayoutId = transfer.id;
    } else {
      throw new Error(`Unsupported provider: ${payout.provider}`);
    }

    // Update payout with provider ID
    await prisma.consultantPayout.update({
      where: { id: payout.id },
      data: {
        providerPayoutId,
        status: PayoutStatus.PROCESSING, // Will be updated via webhook
      },
    });

    result.success = true;
    result.providerPayoutId = providerPayoutId;
    console.log(`✅ Processed payout ${payout.id} → ${providerPayoutId}`);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // #785 — if the gateway ALREADY accepted (providerPayoutId set) but a later
    // DB write threw, the money was SENT. Marking FAILED + unlinking earnings
    // here would re-batch them under a fresh idempotencyKey the gateway won't
    // dedupe → DOUBLE disbursement. Instead persist the gateway id and leave the
    // row PROCESSING with earnings LINKED; handle-stuck-payouts then reconciles
    // it against the gateway. Only a pre-gateway failure FAILs + releases.
    if (providerPayoutId) {
      try {
        await prisma.consultantPayout.update({
          where: { id: payout.id },
          data: {
            providerPayoutId,
            status: PayoutStatus.PROCESSING,
            failureReason:
              `Gateway accepted (${providerPayoutId}); post-submit DB write failed, awaiting reconcile: ${errorMessage}`.slice(
                0,
                500,
              ),
          },
        });
      } catch (persistErr) {
        // Double DB failure — the row stays PROCESSING (from the claim) with
        // earnings still linked (no re-batch). Page for manual reconcile.
        console.error(
          `[process-payouts] CRITICAL: gateway accepted ${providerPayoutId} but DB persist failed twice for payout ${payout.id}; manual reconcile required`,
          persistErr,
        );
      }
      result.providerPayoutId = providerPayoutId;
      result.error = `gateway-accepted-db-write-failed: ${errorMessage}`;
      console.error(
        `⚠️ Payout ${payout.id}: gateway accepted ${providerPayoutId} but DB write failed — quarantined PROCESSING (NOT failed) to avoid double-pay`,
      );
      return result;
    }

    // Genuine pre-gateway failure (rejected / never submitted) — safe to FAIL
    // and release the earnings for a fresh batch.
    await prisma.consultantPayout.update({
      where: { id: payout.id },
      data: {
        status: PayoutStatus.FAILED,
        failureReason: errorMessage,
        retryCount: { increment: 1 },
      },
    });

    // Unlink earnings so they can be included in next batch
    await prisma.consultantEarnings.updateMany({
      where: { payoutId: payout.id },
      data: { payoutId: null },
    });

    result.error = errorMessage;
    console.error(`❌ Failed payout ${payout.id}: ${errorMessage}`);
  }

  return result;
}

/**
 * Process all approved payouts
 *
 * @returns ProcessingResult with details
 */
export async function processApprovedPayouts(): Promise<ProcessingResult> {
  console.log("💸 Starting payout processing...");

  const result: ProcessingResult = {
    success: false,
    processed: 0,
    succeeded: 0,
    failed: 0,
    results: [],
    errors: [],
  };

  try {
    // Get all approved payouts
    const approvedPayouts = await prisma.consultantPayout.findMany({
      where: { status: PayoutStatus.APPROVED },
      include: {
        consultantProfile: {
          include: {
            payoutAccounts: {
              where: { isDefault: true, isVerified: true },
            },
            user: { select: { name: true, email: true } },
          },
        },
      },
    });

    console.log(
      `📊 Found ${approvedPayouts.length} approved payouts to process`,
    );

    if (approvedPayouts.length === 0) {
      console.log("✅ No approved payouts to process");
      result.success = true;
      return result;
    }

    // Process each payout
    for (const payout of approvedPayouts) {
      console.log(
        `\n📤 Processing payout for ${payout.consultantProfile.user.name || "Unknown"}: ₹${(payout.amount / 100).toFixed(2)}`,
      );

      const payoutResult = await processSinglePayout(payout);

      // #776 — a payout claimed by a concurrent run is neither processed, succeeded
      // nor failed by this run; don't count it (it would inflate metrics / fail the
      // run). The run that claimed it owns the outcome.
      if (payoutResult.skipped) {
        continue;
      }

      result.processed++;
      result.results.push(payoutResult);

      if (payoutResult.success) {
        result.succeeded++;
      } else {
        result.failed++;
        if (payoutResult.error) {
          result.errors.push(`Payout ${payout.id}: ${payoutResult.error}`);
        }
      }
    }

    result.success = result.failed === 0;

    // Summary
    console.log(`\n📈 Processing Summary:`);
    console.log(`   📤 Processed: ${result.processed}`);
    console.log(`   ✅ Succeeded: ${result.succeeded}`);
    console.log(`   ❌ Failed: ${result.failed}`);

    if (result.failed > 0) {
      console.warn(`\n⚠️ Failed payouts will be retried in next batch`);
      result.errors.forEach((error, index) => {
        console.warn(`   ${index + 1}. ${error}`);
      });
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Processing failed:", errorMessage);
    result.errors.push(`Job failed: ${errorMessage}`);
    result.success = false;
  }

  return result;
}

/**
 * Process org-side payouts (#713-2 / #700 LED-4).
 *
 * Today only progresses PENDING → PROCESSING and writes the audit
 * trail; live gateway submission lands in PR-3 behind ENABLE_LIVE_PAYOUTS.
 * Errors against a single payout do not abort the rest of the run.
 */
export interface OrgProcessingResult {
  success: boolean;
  scanned: number;
  advanced: number;
  errors: string[];
}

export async function processOrgPayouts(): Promise<OrgProcessingResult> {
  const result: OrgProcessingResult = {
    success: false,
    scanned: 0,
    advanced: 0,
    errors: [],
  };

  const pending = await prisma.organizationPayout.findMany({
    where: { status: PayoutStatus.PENDING },
    select: { id: true, organizationId: true, amountPaise: true },
  });
  result.scanned = pending.length;

  for (const p of pending) {
    try {
      const out = await processOrgPayout(p.id);
      if (out.status === PayoutStatus.PROCESSING) {
        result.advanced++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`OrgPayout ${p.id}: ${message}`);
    }
  }

  result.success = true;
  return result;
}

/**
 * Get processing statistics
 */
export async function getProcessingStats(): Promise<{
  approvedCount: number;
  approvedAmount: number;
  processingCount: number;
  processingAmount: number;
}> {
  const [approved, processing] = await Promise.all([
    prisma.consultantPayout.aggregate({
      where: { status: PayoutStatus.APPROVED },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.consultantPayout.aggregate({
      where: { status: PayoutStatus.PROCESSING },
      _sum: { amount: true },
      _count: true,
    }),
  ]);

  return {
    approvedCount: approved._count,
    approvedAmount: sumPaise(approved._sum.amount),
    processingCount: processing._count,
    processingAmount: sumPaise(processing._sum.amount),
  };
}

/**
 * Run the processing task
 */
export async function runProcessingTask(): Promise<ProcessingResult> {
  const startTime = Date.now();
  console.log(`🚀 Starting payout processing at ${new Date().toISOString()}`);

  try {
    // Get pre-processing stats
    const preStats = await getProcessingStats();
    console.log(`\n📊 Pre-processing Stats:`);
    console.log(
      `   ✅ Approved: ${preStats.approvedCount} (₹${(preStats.approvedAmount / 100).toFixed(2)})`,
    );
    console.log(
      `   🔄 Processing: ${preStats.processingCount} (₹${(preStats.processingAmount / 100).toFixed(2)})`,
    );

    // Process payouts
    const result = await processApprovedPayouts();

    // Org-side processing pass — independent of consultant-side success.
    try {
      const orgResult = await processOrgPayouts();
      console.log(`\n🏢 Org Payout Processing:`);
      console.log(`   Scanned (PENDING): ${orgResult.scanned}`);
      console.log(`   Advanced → PROCESSING: ${orgResult.advanced}`);
      if (orgResult.errors.length > 0) {
        console.warn(`   ⚠️ Org payout issues (non-fatal):`);
        orgResult.errors.forEach((e) => console.warn(`      - ${e}`));
      }
    } catch (err) {
      console.error(
        "❌ Org payout processing threw — consultant processing was unaffected:",
        err,
      );
    }

    // Get post-processing stats
    const postStats = await getProcessingStats();
    console.log(`\n📊 Post-processing Stats:`);
    console.log(
      `   ✅ Approved: ${postStats.approvedCount} (₹${(postStats.approvedAmount / 100).toFixed(2)})`,
    );
    console.log(
      `   🔄 Processing: ${postStats.processingCount} (₹${(postStats.processingAmount / 100).toFixed(2)})`,
    );

    const duration = (Date.now() - startTime) / 1000;
    console.log(`\n⏱️ Job completed in ${duration.toFixed(2)} seconds`);

    return result;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Disconnect from the database
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

// Run the processing if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runProcessingTask()
    .then((result) => {
      if (result.success) {
        console.log("🎉 Payout processing completed successfully");
        process.exit(0);
      } else {
        console.error("❌ Payout processing completed with errors");
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error("💥 Payout processing failed:", error);
      process.exit(1);
    });
}
