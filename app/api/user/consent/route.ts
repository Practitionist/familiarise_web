import { NextResponse } from "next/server";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { recordOperatorConsent } from "@/lib/compliance/operator-consent";

/**
 * POST /api/user/consent — an operator records their own DPDP consent from
 * the back-office consent step (OperatorConsentGate). Self-only: the user id
 * is the session's, never the body's. Operators only, because consumers and
 * org members already have their own consent paths.
 */
export async function POST() {
  const auth = await requirePrivilegedAuth();
  if (auth.error) return auth.error;
  const created = await recordOperatorConsent(auth.session.user.id);
  return NextResponse.json({ granted: true, created });
}
