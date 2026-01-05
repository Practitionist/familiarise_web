/**
 * System Jobs API - Secure Wrapper
 *
 * Provides authenticated access to system jobs for Admin and Staff users.
 * This wrapper verifies user session server-side and calls cleanup routes internally.
 *
 * NO CRON_SECRET is exposed to the frontend.
 * Uses session-based authentication instead.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

// Import job functions directly
import {
  cleanupAbandonedPayments,
  cleanupExpiredApprovalPendingPayments,
} from "@/scripts/cleanup-abandoned-payments";
import { reconcilePendingRefunds } from "@/scripts/reconcile-pending-refunds";
import { reconcileDisputes } from "@/scripts/reconcile-disputes";
import { handleLostDisputes } from "@/scripts/handle-lost-disputes";
import { cascadeRefundToEarnings } from "@/scripts/cascade-refund-earnings";
import { syncPaymentEarnings } from "@/scripts/sync-payment-earnings";
import { releaseEarningsFromHold } from "@/scripts/release-earnings";
import { runAllCleanupTasks as cleanupInvalidAppointments } from "@/scripts/cleanup-invalid-appointments";
import { createPayoutBatch } from "@/scripts/create-payout-batch";
import { processApprovedPayouts } from "@/scripts/process-payouts";

// Job ID to function mapping
type JobResult = {
  success: boolean;
  [key: string]: unknown;
};

type JobFunction = () => Promise<JobResult>;

const JOB_FUNCTIONS: Record<string, JobFunction> = {
  "cleanup-abandoned-payments": async () => {
    const paymentResult = await cleanupAbandonedPayments();
    const approvalResult = await cleanupExpiredApprovalPendingPayments();
    return {
      success: paymentResult.success && approvalResult.success,
      cleanedCount:
        (paymentResult.cleanedCount || 0) + (approvalResult.cleanedCount || 0),
      errorCount:
        (paymentResult.errorCount || 0) + (approvalResult.errorCount || 0),
      paymentCleanup: paymentResult,
      approvalCleanup: approvalResult,
    };
  },
  "cleanup-approval-payments": async () => {
    const result = await cleanupExpiredApprovalPendingPayments();
    return {
      success: result.success,
      cleanedCount: result.cleanedCount,
      errorCount: result.errorCount,
    };
  },
  "reconcile-refunds": async () => {
    const result = await reconcilePendingRefunds();
    return {
      success: result.success,
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      errorCount: result.failedCount,
    };
  },
  "reconcile-disputes": async () => {
    const result = await reconcileDisputes();
    return {
      success: result.success,
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      urgentCount: result.urgentCount,
      errorCount: result.errors.length,
    };
  },
  "handle-lost-disputes": async () => {
    const result = await handleLostDisputes();
    return {
      success: result.success,
      totalProcessed: result.totalProcessed,
      updatedCount: result.updatedCount,
      alreadyPaidCount: result.alreadyPaidCount,
      errorCount: result.errorCount,
    };
  },
  "cascade-refund-earnings": async () => {
    const result = await cascadeRefundToEarnings();
    return {
      success: result.success,
      totalProcessed: result.totalProcessed,
      updatedCount: result.updatedCount,
      errorCount: result.errorCount,
    };
  },
  "sync-payment-earnings": async () => {
    const result = await syncPaymentEarnings();
    return {
      success: result.success,
      totalProcessed: result.totalProcessed,
      createdCount: result.createdCount,
      errorCount: result.errorCount,
    };
  },
  "release-earnings": async () => {
    const result = await releaseEarningsFromHold();
    return {
      success: result.success,
      releasedCount: result.releasedCount,
      errorCount: result.errorCount,
    };
  },
  "cleanup-invalid-appointments": async () => {
    const result = await cleanupInvalidAppointments();
    return {
      success: result.success,
      totalProcessed: result.totalCancelled,
      cleanedCount: result.totalCancelled,
      duplicateConsultations: result.duplicateConsultationsCancelled,
      duplicateSubscriptions: result.duplicateSubscriptionsCancelled,
      invalidDurationConsultations: result.invalidDurationConsultationsCancelled,
      invalidDurationSubscriptions: result.invalidDurationSubscriptionsCancelled,
      errorCount: result.errors.length,
    };
  },
  "create-payout-batch": async () => {
    const result = await createPayoutBatch();
    return {
      success: result.success,
      batchId: result.batchId,
      createdCount: result.payoutsCreated,
      totalAmount: result.totalAmount,
      autoApproved: result.autoApproved,
      pendingApproval: result.pendingApproval,
      errorCount: result.errors.length,
    };
  },
  "process-payouts": async () => {
    const result = await processApprovedPayouts();
    return {
      success: result.success,
      totalProcessed: result.processed,
      succeededCount: result.succeeded,
      failedCount: result.failed,
      errorCount: result.failed,
    };
  },
};

/**
 * POST /api/admin/system-jobs/run
 * Run a system job by ID (requires ADMIN or STAFF role)
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // 1. Verify session
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2. Check admin or staff role
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true, name: true, email: true },
    });

    if (user?.role !== UserRole.STAFF && user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // 3. Get job ID from body
    const { jobId } = await req.json();

    if (!jobId || typeof jobId !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid jobId" },
        { status: 400 },
      );
    }

    // 4. Find and execute the job
    const jobFunction = JOB_FUNCTIONS[jobId];

    if (!jobFunction) {
      return NextResponse.json(
        { error: `Unknown job ID: ${jobId}` },
        { status: 400 },
      );
    }

    console.log(
      `[System Jobs] ${user.name || user.email} (${user.role}) running job: ${jobId}`,
    );

    // 5. Execute the job
    const result = await jobFunction();

    console.log(`[System Jobs] Job ${jobId} completed:`, {
      success: result.success,
      user: user.email,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("[System Jobs] Error running job:", error);
    return NextResponse.json(
      {
        error: "Failed to run job",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
