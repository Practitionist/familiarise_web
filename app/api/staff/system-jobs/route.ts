/**
 * Staff System Jobs API
 * List available system jobs
 */

import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
// Job configuration matching SystemJobsPanel
const SYSTEM_JOBS = [
  {
    id: "cleanup-abandoned-payments",
    name: "Cleanup Abandoned Payments",
    description: "Cancel abandoned payment intents and expire pending payments",
    schedule: "Every 15 minutes",
    category: "Payments",
  },
  {
    id: "cleanup-approval-payments",
    name: "Cleanup Approval Payments",
    description: "Expire 48h+ pending approval payments",
    schedule: "Hourly",
    category: "Payments",
  },
  {
    id: "reconcile-refunds",
    name: "Reconcile Pending Refunds",
    description: "Sync refund status with payment gateways",
    schedule: "Every 15 minutes",
    category: "Refunds",
  },
  {
    id: "reconcile-disputes",
    name: "Reconcile Disputes",
    description: "Sync dispute status with Stripe",
    schedule: "Every 6 hours",
    category: "Disputes",
  },
  {
    id: "handle-lost-disputes",
    name: "Handle Lost Disputes",
    description: "Reverse earnings on lost disputes",
    schedule: "Every 6 hours",
    category: "Disputes",
  },
  {
    id: "release-earnings",
    name: "Release Earnings from Hold",
    description: "Move PENDING earnings to READY after hold period",
    schedule: "Hourly",
    category: "Earnings",
  },
  {
    id: "create-payout-batch",
    name: "Create Payout Batch",
    description: "Create weekly payout batches",
    schedule: "Weekly (Mon 8PM UTC)",
    category: "Payouts",
  },
  {
    id: "process-payouts",
    name: "Process Payouts",
    description: "Send approved payouts",
    schedule: "Weekly (Mon 9PM UTC)",
    category: "Payouts",
  },
  {
    id: "auth-tokens",
    name: "Auth Token Cleanup",
    description: "Delete expired sessions and tokens",
    schedule: "Daily",
    category: "Cleanup",
  },
];

/**
 * GET /api/staff/system-jobs
 * List all available system jobs
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.STAFF && user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Get recent execution stats for each job
    const recentExecutions = await prisma.systemJobExecution.groupBy({
      by: ["jobId"],
      _count: { id: true },
      _max: { startedAt: true },
      where: {
        startedAt: {
          gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
        },
      },
    });

    const executionMap = new Map(
      recentExecutions.map((e) => [
        e.jobId,
        { count: e._count.id, lastRun: e._max.startedAt },
      ]),
    );

    const jobsWithStats = SYSTEM_JOBS.map((job) => ({
      ...job,
      recentExecutions: executionMap.get(job.id)?.count || 0,
      lastRun: executionMap.get(job.id)?.lastRun || null,
    }));

    return NextResponse.json({ jobs: jobsWithStats });
  } catch (error) {
    console.error("Error fetching system jobs:", error);
    return NextResponse.json(
      { error: "Failed to fetch system jobs" },
      { status: 500 },
    );
  }
}
