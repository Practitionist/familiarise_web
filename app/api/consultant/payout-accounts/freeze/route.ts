/**
 * POST /api/consultant/payout-accounts/freeze — sent by the confirm page the
 * payout-account change email links to. Freezes every payout account of the
 * signed-in consultant; mint refuses a frozen default and only an admin lifts it.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { isSameOriginJsonRequest } from "@/lib/api/same-origin";
import { recordSystemEventSafe } from "@/lib/enterprise/system-events";

export async function POST(req: NextRequest) {
  if (!isSameOriginJsonRequest(req)) {
    return NextResponse.json(
      { error: "Cross-site request refused", code: "CROSS_SITE" },
      { status: 403 },
    );
  }
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

  return NextResponse.json({ frozen: true, accounts: frozen.count });
}
