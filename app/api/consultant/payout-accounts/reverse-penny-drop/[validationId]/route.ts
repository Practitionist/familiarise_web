/**
 * GET /api/consultant/payout-accounts/reverse-penny-drop/[validationId]
 * (#1675 PR-Y2). One poll: pending, failed, or verified — the last persists the
 * reference-only account row. Ownership is checked against the validation's
 * reference_id inside the settle step.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireOwnConsultantProfile } from "@/lib/api/consultant-profile";
import { apiError } from "@/lib/errors/api-error";
import { settleReversePennyDrop } from "@/lib/payments/payouts/reverse-penny-drop";

interface RouteParams {
  params: Promise<{ validationId: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { profileId, error: profileError } =
      await requireOwnConsultantProfile();
    if (profileError) return profileError;
    const { validationId } = await params;
    const outcome = await settleReversePennyDrop(
      profileId,
      validationId,
    );
    return NextResponse.json(outcome, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError({
      tag: "[Consultant.ReversePennyDrop.GET]",
      error,
      fallbackMessage: "Could not check the ₹1 verification",
    });
  }
}
