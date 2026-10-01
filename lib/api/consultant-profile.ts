import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import type { Session } from "@/lib/auth";

/**
 * Force-fresh session + the caller's own consultant id, or a ready-to-return
 * 401/404. Collapses the identical auth preamble previously copy-pasted
 * across consultant finance routes (tax-info, payout-setup, reverse-penny-drop
 * validation) — Sonar flagged the repetition once the freshness bulk touched
 * it (#1814). Routes needing a fuller profile (tax rows, payout accounts
 * with relations) keep their own query; this is only the id gate.
 */
export async function requireOwnConsultantProfile(): Promise<
  | { session: Session; profileId: string; error?: never }
  | { session?: never; profileId?: never; error: NextResponse }
> {
  const session = await getSession(true);
  if (!session?.user?.id) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  const profile = await prisma.consultantProfile.findUnique({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (!profile) {
    return {
      error: NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      ),
    };
  }
  return { session, profileId: profile.id };
}
