/**
 * Admin Payout Management API
 * Approve, reject, or get details of specific payouts
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { z } from "zod";
import {
  requireAdminAuth,
  requirePrivilegedAuth,
} from "@/lib/auth-helpers";
import {
  getPayoutById,
  approvePayout,
  rejectPayout,
} from "@/lib/payments/payouts";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const actionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  reason: z.string().optional(),
});

/**
 * GET /api/admin/payouts/[id]
 * Get payout details
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { id } = await params;
    const payout = await getPayoutById(id);

    if (!payout) {
      return NextResponse.json({ error: "Payout not found" }, { status: 404 });
    }

    return NextResponse.json({ payout });
  } catch (error) {
    console.error("Error fetching payout:", error);
    return NextResponse.json(
      { error: "Failed to fetch payout" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/admin/payouts/[id]
 * Approve or reject a payout. Admin-only — `approvePayout()` triggers real
 * money movement, so staff is kept read-only even though the GET sibling
 * above is privileged.
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireAdminAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    const { id } = await params;
    const body = await req.json();
    const { action, reason } = actionSchema.parse(body);

    // Verify payout exists and is pending
    const payout = await prisma.payout.findUnique({
      where: { id },
    });

    if (!payout) {
      return NextResponse.json({ error: "Payout not found" }, { status: 404 });
    }

    if (payout.status !== "PENDING") {
      return NextResponse.json(
        { error: `Cannot ${action} payout with status ${payout.status}` },
        { status: 400 },
      );
    }

    if (action === "approve") {
      await approvePayout(id, session.user.id);
      return NextResponse.json({
        success: true,
        message: "Payout approved successfully",
      });
    } else {
      if (!reason) {
        return NextResponse.json(
          { error: "Reason is required for rejection" },
          { status: 400 },
        );
      }
      await rejectPayout(id, reason);
      return NextResponse.json({
        success: true,
        message: "Payout rejected successfully",
      });
    }
  } catch (error) {
    console.error("Error processing payout action:", error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid action", details: error.errors },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Failed to process payout action" },
      { status: 500 },
    );
  }
}
