/**
 * Admin Payouts API
 * Manage consultant payouts (view, batch-create).
 *
 * GET is a thin shell — listing/aggregation logic lives in
 * `lib/api/operators/payouts.ts` and is shared with `/api/staff/payouts`.
 *
 * POST (batch creation) stays inline because staff does not have it.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  classifyError,
  logClassifiedError,
} from "@/lib/errors/classification/payment-error-classification";
import { PayoutStatus } from "@prisma/client";
import { createPayoutBatch } from "@/lib/payments/payouts";
import {
  requireAdminAuth,
  requireBackofficeSurface,
} from "@/lib/auth-helpers";
import { getOperatorPayouts } from "@/lib/api/operators";
import {
  adminPayoutBatchSchema,
  adminPayoutsQuerySchema,
} from "@/schemas/payouts";

/**
 * GET /api/admin/payouts
 * Get payouts with optional status + search filters
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("payouts.read");
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const parsedQuery = adminPayoutsQuerySchema.safeParse({
      status: searchParams.get("status"),
      search: searchParams.get("search"),
      // #674 comment 7 — org-scope filter via earnings.payment.organizationId.
      orgId: searchParams.get("orgId"),
      limit: searchParams.get("limit") ?? undefined,
      offset: searchParams.get("offset") ?? undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json(
        { error: "Invalid query parameters", issues: parsedQuery.error.issues },
        { status: 400 },
      );
    }
    const result = await getOperatorPayouts({
      status: parsedQuery.data.status as PayoutStatus | null,
      search: parsedQuery.data.search,
      orgId: parsedQuery.data.orgId,
      limit: parsedQuery.data.limit,
      offset: parsedQuery.data.offset,
    });

    return NextResponse.json(result);
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Error fetching payouts:", error);
    return NextResponse.json(
      { error: "Failed to fetch payouts" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/admin/payouts
 * Create a new payout batch for one or more consultants. Admin-only — staff
 * does not have a parallel endpoint, so this stays inline rather than being
 * extracted into the shared operator module. Gated with `requireAdminAuth`
 * because batch creation triggers real money movement; staff is read-only.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdminAuth();
    if (auth.error) return auth.error;

    const body = await req.json();
    const parsed = adminPayoutBatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid batch request", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const { consultantProfileIds } = parsed.data;

    // Create payout batch
    const batchId = await createPayoutBatch(consultantProfileIds);

    // Get created payouts
    const payouts = await prisma.consultantPayout.findMany({
      where: { batchId },
      include: {
        consultantProfile: {
          include: {
            user: { select: { name: true, email: true } },
          },
        },
      },
    });

    return NextResponse.json({
      success: true,
      batchId,
      payoutsCreated: payouts.length,
      payouts: payouts.map((p) => ({
        id: p.id,
        consultantName: p.consultantProfile.user.name,
        amount: p.amount,
        status: p.status,
      })),
    });
  } catch (error) {
    const classified = classifyError(error, "Failed to create payout batch");
    logClassifiedError("Payouts", classified, error);

    if (classified.httpStatus >= 500) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    }

    return NextResponse.json(
      { error: classified.errorMessage },
      { status: classified.httpStatus },
    );
  }
}
