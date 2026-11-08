import { NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { applyRateLimit, expertLinkLimiter } from "@/lib/rate-limit";
import { expertShareHref } from "@/lib/referrals/attribution-token";

/** The signed own-link share URL path for the signed-in expert's public page. */
export async function GET() {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rl = await applyRateLimit(expertLinkLimiter, session.user.id);
  if (rl) return rl;
  const profile = await prisma.consultantProfile.findUnique({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (!profile) {
    return NextResponse.json({ error: "Not an expert" }, { status: 404 });
  }
  return NextResponse.json({
    consultantProfileId: profile.id,
    href: expertShareHref(profile.id),
  });
}
