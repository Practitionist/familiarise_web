/**
 * POST /api/consultant/payout-accounts/reverse-penny-drop (#1675 PR-Y2).
 * Mints the ₹1 UPI intent; nothing is persisted until the poll step settles.
 */

import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { apiError } from "@/lib/errors/api-error";
import { startReversePennyDrop } from "@/lib/payments/payouts/reverse-penny-drop";

export async function POST() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });
    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }
    const started = await startReversePennyDrop(consultantProfile.id);
    return NextResponse.json(started);
  } catch (error) {
    return apiError({
      tag: "[Consultant.ReversePennyDrop.POST]",
      error,
      fallbackMessage: "Could not start the ₹1 verification",
    });
  }
}
