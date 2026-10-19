/**
 * GET /api/consultant/payout-accounts/freeze — the "this wasn't me" link in the
 * payout-account change email. Freezes every payout account of the signed-in
 * consultant; mint refuses a frozen default and only an admin lifts it.
 */

import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { recordSystemEventSafe } from "@/lib/enterprise/system-events";
import { payoutSettingsHref } from "@/lib/payments/payouts/payout-requirements";
import { getAppUrl } from "@/lib/url";

export async function GET() {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const profile = await prisma.consultantProfile.findUnique({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (!profile) {
    return NextResponse.json(
      { error: "Consultant profile not found" },
      { status: 404 },
    );
  }

  const frozen = await prisma.payoutAccount.updateMany({
    where: { consultantProfileId: profile.id, payoutsFrozenAt: null },
    data: { payoutsFrozenAt: new Date() },
  });
  await recordSystemEventSafe({
    category: "PAYOUT",
    severity: "WARN",
    message: `PAYOUT_ACCOUNT_FROZEN_BY_PAYEE: consultant ${profile.id} froze payouts from the bank-change email`,
    context: { consultantProfileId: profile.id, accounts: frozen.count },
  });

  return NextResponse.redirect(
    `${getAppUrl()}${payoutSettingsHref(profile.id)}?payouts=frozen`,
  );
}
