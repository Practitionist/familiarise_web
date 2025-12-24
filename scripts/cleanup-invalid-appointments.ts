#!/usr/bin/env node

/**
 * Invalid Appointment Cleanup Script
 *
 * Core library for cleaning up duplicate and invalid appointments.
 *
 * This module exports functions that can be used by:
 * - Local development: `npx tsx scripts/cleanup-invalid-appointments.ts`
 * - GitHub Actions: `jobs/cleanup-invalid-appointments.ts`
 * - API routes: Can import and call functions directly
 *
 * Cleanup Categories:
 * 1. Duplicate consultations (same user + consultant + plan + same day)
 * 2. Duplicate subscriptions (overlapping scheduling periods)
 * 3. Exact duplicates (records created within 5 seconds - double-submit bugs)
 * 4. Invalid duration consultations (slot duration != plan duration)
 * 5. Invalid duration subscriptions (period != plan.durationInMonths)
 *
 * Action: Marks invalid records as CANCELLED (preserves audit trail)
 */

import { PrismaClient, RequestStatus } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Result structure for cleanup operations
 */
export interface CleanupResult {
  duplicateConsultationsCancelled: number;
  duplicateSubscriptionsCancelled: number;
  invalidDurationConsultationsCancelled: number;
  invalidDurationSubscriptionsCancelled: number;
  totalCancelled: number;
  errors: string[];
  success: boolean;
}

// Statuses that should not be cleaned up (already terminal)
const TERMINAL_STATUSES = [
  RequestStatus.CANCELLED,
  RequestStatus.REJECTED,
  RequestStatus.EXPIRED,
];

/**
 * Clean up duplicate consultations
 *
 * Finds consultations where:
 * - Same requestedById (user)
 * - Same consultationPlanId (plan)
 * - Created on the same day OR within 5 seconds of each other
 *
 * Keeps the oldest record, cancels the newer duplicates.
 */
export async function cleanupDuplicateConsultations(): Promise<{
  count: number;
  errors: string[];
}> {
  console.log("🔍 Finding duplicate consultations...");

  const errors: string[] = [];
  let cancelledCount = 0;

  try {
    // Find duplicate consultations (same user + plan + same day)
    // Using raw query for efficient duplicate detection
    const duplicates = await prisma.$queryRaw<
      Array<{ duplicate_id: string; original_id: string; reason: string }>
    >`
      WITH ranked_consultations AS (
        SELECT
          c.id,
          c."requestedById",
          c."consultationPlanId",
          c."requestStatus",
          c."createdAt",
          ROW_NUMBER() OVER (
            PARTITION BY c."requestedById", c."consultationPlanId", DATE(c."createdAt")
            ORDER BY c."createdAt" ASC
          ) as rn
        FROM "Consultation" c
        WHERE c."requestStatus" NOT IN ('CANCELLED', 'REJECTED', 'EXPIRED')
      )
      SELECT
        r.id as duplicate_id,
        (SELECT id FROM ranked_consultations WHERE "requestedById" = r."requestedById"
         AND "consultationPlanId" = r."consultationPlanId"
         AND DATE("createdAt") = DATE(r."createdAt") AND rn = 1) as original_id,
        'same_day_duplicate' as reason
      FROM ranked_consultations r
      WHERE r.rn > 1

      UNION ALL

      -- Exact duplicates (within 5 seconds)
      SELECT DISTINCT ON (c1.id)
        c1.id as duplicate_id,
        c2.id as original_id,
        'exact_duplicate_5s' as reason
      FROM "Consultation" c1
      JOIN "Consultation" c2 ON
        c1.id != c2.id AND
        c1."requestedById" = c2."requestedById" AND
        c1."consultationPlanId" = c2."consultationPlanId" AND
        ABS(EXTRACT(EPOCH FROM (c1."createdAt" - c2."createdAt"))) < 5 AND
        c1."createdAt" > c2."createdAt"
      WHERE c1."requestStatus" NOT IN ('CANCELLED', 'REJECTED', 'EXPIRED')
        AND c2."requestStatus" NOT IN ('CANCELLED', 'REJECTED', 'EXPIRED')
    `;

    console.log(`📊 Found ${duplicates.length} duplicate consultations`);

    // Cancel each duplicate
    for (const dup of duplicates) {
      try {
        await prisma.consultation.update({
          where: { id: dup.duplicate_id },
          data: {
            requestStatus: RequestStatus.CANCELLED,
            updatedAt: new Date(),
          },
        });
        cancelledCount++;
        console.log(
          `✅ Cancelled duplicate consultation: ${dup.duplicate_id} (${dup.reason})`
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        errors.push(
          `Failed to cancel consultation ${dup.duplicate_id}: ${errorMessage}`
        );
        console.error(
          `❌ Failed to cancel consultation ${dup.duplicate_id}:`,
          errorMessage
        );
      }
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    errors.push(`Duplicate consultation query failed: ${errorMessage}`);
    console.error("❌ Failed to find duplicate consultations:", errorMessage);
  }

  return { count: cancelledCount, errors };
}

/**
 * Clean up duplicate subscriptions
 *
 * Finds subscriptions where:
 * - Same requestedById (user)
 * - Same subscriptionPlanId (plan)
 * - Overlapping scheduling periods OR within 5 seconds of each other
 *
 * Keeps the oldest record, cancels the newer duplicates.
 */
export async function cleanupDuplicateSubscriptions(): Promise<{
  count: number;
  errors: string[];
}> {
  console.log("🔍 Finding duplicate subscriptions...");

  const errors: string[] = [];
  let cancelledCount = 0;

  try {
    // Find duplicate subscriptions (overlapping periods or exact duplicates)
    const duplicates = await prisma.$queryRaw<
      Array<{ duplicate_id: string; original_id: string; reason: string }>
    >`
      -- Overlapping scheduling periods
      SELECT DISTINCT ON (s1.id)
        s1.id as duplicate_id,
        s2.id as original_id,
        'overlapping_period' as reason
      FROM "Subscription" s1
      JOIN "Subscription" s2 ON
        s1.id != s2.id AND
        s1."requestedById" = s2."requestedById" AND
        s1."subscriptionPlanId" = s2."subscriptionPlanId" AND
        s1."schedulingPeriodStartsAt" < s2."schedulingPeriodEndsAt" AND
        s1."schedulingPeriodEndsAt" > s2."schedulingPeriodStartsAt" AND
        s1."createdAt" > s2."createdAt"
      WHERE s1."requestStatus" NOT IN ('CANCELLED', 'REJECTED', 'EXPIRED')
        AND s2."requestStatus" NOT IN ('CANCELLED', 'REJECTED', 'EXPIRED')

      UNION ALL

      -- Exact duplicates (within 5 seconds)
      SELECT DISTINCT ON (s1.id)
        s1.id as duplicate_id,
        s2.id as original_id,
        'exact_duplicate_5s' as reason
      FROM "Subscription" s1
      JOIN "Subscription" s2 ON
        s1.id != s2.id AND
        s1."requestedById" = s2."requestedById" AND
        s1."subscriptionPlanId" = s2."subscriptionPlanId" AND
        ABS(EXTRACT(EPOCH FROM (s1."createdAt" - s2."createdAt"))) < 5 AND
        s1."createdAt" > s2."createdAt"
      WHERE s1."requestStatus" NOT IN ('CANCELLED', 'REJECTED', 'EXPIRED')
        AND s2."requestStatus" NOT IN ('CANCELLED', 'REJECTED', 'EXPIRED')
    `;

    console.log(`📊 Found ${duplicates.length} duplicate subscriptions`);

    // Cancel each duplicate
    for (const dup of duplicates) {
      try {
        await prisma.subscription.update({
          where: { id: dup.duplicate_id },
          data: {
            requestStatus: RequestStatus.CANCELLED,
            updatedAt: new Date(),
          },
        });
        cancelledCount++;
        console.log(
          `✅ Cancelled duplicate subscription: ${dup.duplicate_id} (${dup.reason})`
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        errors.push(
          `Failed to cancel subscription ${dup.duplicate_id}: ${errorMessage}`
        );
        console.error(
          `❌ Failed to cancel subscription ${dup.duplicate_id}:`,
          errorMessage
        );
      }
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    errors.push(`Duplicate subscription query failed: ${errorMessage}`);
    console.error("❌ Failed to find duplicate subscriptions:", errorMessage);
  }

  return { count: cancelledCount, errors };
}

/**
 * Clean up consultations with invalid slot durations
 *
 * Finds consultations where the total slot duration doesn't match
 * the plan's durationInHours (with 1% tolerance for floating point).
 */
export async function cleanupInvalidDurationConsultations(): Promise<{
  count: number;
  errors: string[];
}> {
  console.log("🔍 Finding consultations with invalid slot durations...");

  const errors: string[] = [];
  let cancelledCount = 0;

  try {
    // Find consultations where slot duration doesn't match plan duration
    const invalidConsultations = await prisma.$queryRaw<
      Array<{
        consultation_id: string;
        expected_hours: number;
        actual_hours: number;
      }>
    >`
      SELECT
        c.id as consultation_id,
        cp."durationInHours" as expected_hours,
        EXTRACT(EPOCH FROM (s."endsAt" - s."startsAt"))/3600 as actual_hours
      FROM "Consultation" c
      JOIN "ConsultationPlan" cp ON c."consultationPlanId" = cp.id
      JOIN "Appointment" a ON a."consultationId" = c.id
      JOIN "SlotOfAppointment" s ON s."appointmentId" = a.id
      WHERE c."requestStatus" NOT IN ('CANCELLED', 'REJECTED', 'EXPIRED')
        AND ABS(cp."durationInHours" - EXTRACT(EPOCH FROM (s."endsAt" - s."startsAt"))/3600) > 0.01
    `;

    console.log(
      `📊 Found ${invalidConsultations.length} consultations with invalid durations`
    );

    // Cancel each invalid consultation
    for (const invalid of invalidConsultations) {
      try {
        await prisma.consultation.update({
          where: { id: invalid.consultation_id },
          data: {
            requestStatus: RequestStatus.CANCELLED,
            updatedAt: new Date(),
          },
        });
        cancelledCount++;
        console.log(
          `✅ Cancelled invalid duration consultation: ${invalid.consultation_id} ` +
            `(expected: ${invalid.expected_hours}h, actual: ${invalid.actual_hours.toFixed(2)}h)`
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        errors.push(
          `Failed to cancel consultation ${invalid.consultation_id}: ${errorMessage}`
        );
        console.error(
          `❌ Failed to cancel consultation ${invalid.consultation_id}:`,
          errorMessage
        );
      }
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    errors.push(`Invalid duration consultation query failed: ${errorMessage}`);
    console.error(
      "❌ Failed to find invalid duration consultations:",
      errorMessage
    );
  }

  return { count: cancelledCount, errors };
}

/**
 * Clean up subscriptions with invalid scheduling periods
 *
 * Finds subscriptions where the scheduling period doesn't match
 * the plan's durationInMonths.
 */
export async function cleanupInvalidDurationSubscriptions(): Promise<{
  count: number;
  errors: string[];
}> {
  console.log("🔍 Finding subscriptions with invalid scheduling periods...");

  const errors: string[] = [];
  let cancelledCount = 0;

  try {
    // Find subscriptions where period doesn't match plan duration
    const invalidSubscriptions = await prisma.$queryRaw<
      Array<{
        subscription_id: string;
        expected_months: number;
        actual_months: number;
      }>
    >`
      SELECT
        s.id as subscription_id,
        sp."durationInMonths" as expected_months,
        EXTRACT(MONTH FROM AGE(s."schedulingPeriodEndsAt", s."schedulingPeriodStartsAt")) +
        EXTRACT(YEAR FROM AGE(s."schedulingPeriodEndsAt", s."schedulingPeriodStartsAt")) * 12 as actual_months
      FROM "Subscription" s
      JOIN "SubscriptionPlan" sp ON s."subscriptionPlanId" = sp.id
      WHERE s."requestStatus" NOT IN ('CANCELLED', 'REJECTED', 'EXPIRED')
        AND (
          EXTRACT(MONTH FROM AGE(s."schedulingPeriodEndsAt", s."schedulingPeriodStartsAt")) +
          EXTRACT(YEAR FROM AGE(s."schedulingPeriodEndsAt", s."schedulingPeriodStartsAt")) * 12
        ) != sp."durationInMonths"
    `;

    console.log(
      `📊 Found ${invalidSubscriptions.length} subscriptions with invalid periods`
    );

    // Cancel each invalid subscription
    for (const invalid of invalidSubscriptions) {
      try {
        await prisma.subscription.update({
          where: { id: invalid.subscription_id },
          data: {
            requestStatus: RequestStatus.CANCELLED,
            updatedAt: new Date(),
          },
        });
        cancelledCount++;
        console.log(
          `✅ Cancelled invalid duration subscription: ${invalid.subscription_id} ` +
            `(expected: ${invalid.expected_months} months, actual: ${invalid.actual_months} months)`
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        errors.push(
          `Failed to cancel subscription ${invalid.subscription_id}: ${errorMessage}`
        );
        console.error(
          `❌ Failed to cancel subscription ${invalid.subscription_id}:`,
          errorMessage
        );
      }
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    errors.push(`Invalid duration subscription query failed: ${errorMessage}`);
    console.error(
      "❌ Failed to find invalid duration subscriptions:",
      errorMessage
    );
  }

  return { count: cancelledCount, errors };
}

/**
 * Run all cleanup tasks
 *
 * Executes all four cleanup operations:
 * 1. Duplicate consultations
 * 2. Duplicate subscriptions
 * 3. Invalid duration consultations
 * 4. Invalid duration subscriptions
 *
 * @returns Combined results from all cleanup operations
 */
export async function runAllCleanupTasks(): Promise<CleanupResult> {
  const startTime = Date.now();
  console.log(`\n🚀 Starting invalid appointment cleanup at ${new Date().toISOString()}\n`);

  const result: CleanupResult = {
    duplicateConsultationsCancelled: 0,
    duplicateSubscriptionsCancelled: 0,
    invalidDurationConsultationsCancelled: 0,
    invalidDurationSubscriptionsCancelled: 0,
    totalCancelled: 0,
    errors: [],
    success: false,
  };

  try {
    // 1. Cleanup duplicate consultations
    console.log("\n📋 Step 1/4: Duplicate Consultations");
    const dupConsultations = await cleanupDuplicateConsultations();
    result.duplicateConsultationsCancelled = dupConsultations.count;
    result.errors.push(...dupConsultations.errors);

    // 2. Cleanup duplicate subscriptions
    console.log("\n📋 Step 2/4: Duplicate Subscriptions");
    const dupSubscriptions = await cleanupDuplicateSubscriptions();
    result.duplicateSubscriptionsCancelled = dupSubscriptions.count;
    result.errors.push(...dupSubscriptions.errors);

    // 3. Cleanup invalid duration consultations
    console.log("\n📋 Step 3/4: Invalid Duration Consultations");
    const invalidConsultations = await cleanupInvalidDurationConsultations();
    result.invalidDurationConsultationsCancelled = invalidConsultations.count;
    result.errors.push(...invalidConsultations.errors);

    // 4. Cleanup invalid duration subscriptions
    console.log("\n📋 Step 4/4: Invalid Duration Subscriptions");
    const invalidSubscriptions = await cleanupInvalidDurationSubscriptions();
    result.invalidDurationSubscriptionsCancelled = invalidSubscriptions.count;
    result.errors.push(...invalidSubscriptions.errors);

    // Calculate totals
    result.totalCancelled =
      result.duplicateConsultationsCancelled +
      result.duplicateSubscriptionsCancelled +
      result.invalidDurationConsultationsCancelled +
      result.invalidDurationSubscriptionsCancelled;

    result.success = result.errors.length === 0;

    // Summary
    const duration = (Date.now() - startTime) / 1000;
    console.log(`\n📊 Cleanup Summary:`);
    console.log(
      `   🔄 Duplicate consultations cancelled: ${result.duplicateConsultationsCancelled}`
    );
    console.log(
      `   🔄 Duplicate subscriptions cancelled: ${result.duplicateSubscriptionsCancelled}`
    );
    console.log(
      `   ⏱️ Invalid duration consultations cancelled: ${result.invalidDurationConsultationsCancelled}`
    );
    console.log(
      `   ⏱️ Invalid duration subscriptions cancelled: ${result.invalidDurationSubscriptionsCancelled}`
    );
    console.log(`   📈 Total cancelled: ${result.totalCancelled}`);
    console.log(`   ⏱️ Duration: ${duration.toFixed(2)}s`);

    if (result.errors.length > 0) {
      console.log(`\n⚠️ Errors (${result.errors.length}):`);
      result.errors.forEach((error, i) => {
        console.log(`   ${i + 1}. ${error}`);
      });
    }

    return result;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Disconnect from the database
 * Call this when done using the cleanup functions if not using runAllCleanupTasks
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

// Run the cleanup if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllCleanupTasks()
    .then((result) => {
      if (result.success) {
        console.log("\n🎉 Cleanup job completed successfully");
        process.exit(0);
      } else {
        console.error("\n❌ Cleanup job completed with errors");
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error("\n💥 Cleanup job failed:", error);
      process.exit(1);
    });
}
