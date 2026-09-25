/**
 * Admin Payout Management API
 * Approve, reject, or get details of specific payouts
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { z } from "zod";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  getPayoutById,
  approvePayout,
  rejectPayout,
} from "@/lib/payments/payouts";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/admin/payouts/[id]
 * Get payout details
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireBackofficeSurface("payouts.read");
    if (auth.error) return auth.error;

    const { id } = await params;
    const payout = await getPayoutById(id);

    if (!payout) {
      return NextResponse.json({ error: "Payout not found" }, { status: 404 });
    }

    return NextResponse.json({ payout });
  } catch (error) {
    console.error("Error fetching payout:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    return NextResponse.json(
      { error: "Failed to fetch payout" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/admin/payouts/[id]
 * Approve or reject a PENDING payout — including an above-cap instant payout
 * waiting for approval (#1771 row 6). `approvePayout()` moves real money, so
 * this is `payouts.manage` (ADMIN); both decisions need a reason and write one
 * OpsActionLog row after the service call (#1771 K-4).
 */
export const POST = withOpsAction(
  "payouts.manage",
  (body) => `payout.${body.action}`,
  { action: z.enum(["approve", "reject"]) },
  {
    mode: "gateway",
    target: ({ params }) => ({ kind: "ConsultantPayout", id: params.id }),
    run: async ({ params, body, actor }) => {
      const payout = await prisma.consultantPayout.findUnique({
        where: { id: params.id },
        select: { status: true, kind: true, amount: true },
      });
      if (!payout) {
        throw new OpsRefusal("PAYOUT_NOT_FOUND", "Payout not found.", 404);
      }
      if (payout.status !== "PENDING") {
        throw notPending(payout.status);
      }
      try {
        if (body.action === "approve") {
          await approvePayout(params.id, actor.userId);
        } else {
          await rejectPayout(params.id, body.reason);
        }
      } catch (err) {
        // The service CAS lost to a concurrent decision: a state, not a fault.
        const msg = err instanceof Error ? err.message : "";
        if (/cannot be (approved|rejected)/.test(msg)) throw notPending(null);
        throw err;
      }
      const status = body.action === "approve" ? "APPROVED" : "CANCELLED";
      return {
        target: { kind: "ConsultantPayout", id: params.id },
        before: {
          status: payout.status,
          kind: payout.kind,
          amountPaise: Number(payout.amount),
        },
        after: { payoutStatus: status },
        response: {
          success: true,
          message:
            body.action === "approve"
              ? "Payout approved successfully"
              : "Payout rejected successfully",
        },
      };
    },
  },
);

function notPending(status: string | null) {
  return new OpsRefusal(
    "PAYOUT_NOT_PENDING",
    status
      ? `Only a pending payout can be decided (this one is ${status}).`
      : "Another decision on this payout landed first — reload the list.",
  );
}
