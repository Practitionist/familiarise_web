/**
 * Admin Payouts API
 * Manage consultant payouts (view, batch-create).
 *
 * GET is a thin shell — listing/aggregation logic lives in
 * `lib/api/operators/payouts.ts`; staff read it too (`payouts.read`).
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
import { createPayoutBatch } from "@/lib/payments/payouts";
import { requireAdminAuth, requireBackofficeSurface } from "@/lib/auth-helpers";
import { getOperatorPayouts } from "@/lib/api/operators";
import { parseRequestBody, parseJsonRequest } from "@/lib/api/parse";
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
    const { data: query, error: queryError } = parseRequestBody(
      adminPayoutsQuerySchema,
      {
        status: searchParams.get("status"),
        statusIn: searchParams.get("statusIn")?.split(",") ?? null,
        kind: searchParams.get("kind"),
        search: searchParams.get("search"),
        // #674 comment 7 — org-scope filter via earnings.payment.organizationId.
        orgId: searchParams.get("orgId"),
        limit: searchParams.get("limit") ?? undefined,
        offset: searchParams.get("offset") ?? undefined,
      },
      "Invalid query parameters",
    );
    if (queryError) return queryError;
    const result = await getOperatorPayouts({
      status: query.status ?? null,
      statusIn: query.statusIn ?? null,
      kind: query.kind ?? null,
      search: query.search,
      orgId: query.orgId,
      limit: query.limit,
      offset: query.offset,
    });

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
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

    const { data, error } = await parseJsonRequest(adminPayoutBatchSchema, req);
    if (error) return error;
    const { consultantProfileIds } = data;

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
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "admin" } },
      );
    }

    return NextResponse.json(
      { error: classified.errorMessage },
      { status: classified.httpStatus },
    );
  }
}
