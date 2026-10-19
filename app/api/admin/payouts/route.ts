/**
 * Admin Payouts API
 * Manage consultant payouts (view, batch-create).
 *
 * GET is a thin shell — listing/aggregation logic lives in
 * `lib/api/operators/payouts.ts`; staff read it too (`payouts.read`).
 */

import { PARTY_PROFILE_SELECT } from "@/lib/booking/list-selects";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { createPayoutBatch } from "@/lib/payments/payouts";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { getOperatorPayouts } from "@/lib/api/operators";
import { parseRequestBody } from "@/lib/api/parse";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
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
 * POST /api/admin/payouts — mint a payout batch for the named consultants.
 * ADMIN, step-up, a reason and an ops log row; a retry re-mints nothing,
 * because the first run already claimed every READY earning.
 */
export const POST = withOpsAction(
  "payouts.manage",
  "payout.batchCreate",
  adminPayoutBatchSchema.shape,
  {
    mode: "gateway",
    target: () => ({ kind: "PayoutBatch", id: "new" }),
    run: async ({ body, actor }) => {
      await assertMoneyOpsBudget(actor.userId);
      const run = await createPayoutBatch(body.consultantProfileIds, {
        createdBy: actor.userId,
      });
      const payouts = await prisma.consultantPayout.findMany({
        where: { batchId: run.batchId },
        include: { consultantProfile: PARTY_PROFILE_SELECT },
      });
      return {
        target: { kind: "PayoutBatch", id: run.batchId },
        after: {
          minted: run.minted,
          failed: run.failed,
          totalPaise: payouts.reduce((s, p) => s + Number(p.amount), 0),
        },
        response: {
          success: true,
          batchId: run.batchId,
          minted: run.minted,
          failed: run.failed,
          payoutsCreated: payouts.length,
          payouts: payouts.map((p) => ({
            id: p.id,
            consultantName: p.consultantProfile.user.name,
            amount: p.amount,
            status: p.status,
          })),
        },
      };
    },
  },
  { stepUp: true },
);
