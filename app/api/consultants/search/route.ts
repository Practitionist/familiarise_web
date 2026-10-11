import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import { searchLimiter, applyRateLimit, getClientIp } from "@/lib/rate-limit";
import { hasOrgPermission } from "@/lib/auth/org-permissions";

function maskEmail(email: string | null | undefined): string {
  if (!email) return "";
  const atIdx = email.indexOf("@");
  if (atIdx <= 0) return "***";
  return `${email.slice(0, 1)}***@${email.slice(atIdx + 1)}`;
}

export async function GET(req: NextRequest) {
  try {
    const rl = await applyRateLimit(searchLimiter, getClientIp(req));
    if (rl) return rl;

    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let canSearch = Boolean(session.user.consultantProfileId);
    if (!canSearch) {
      const memberships = await prisma.membership.findMany({
        where: {
          userId: session.user.id,
          status: "ACTIVE",
          organization: { status: { not: "DEACTIVATED" } },
        },
        select: { role: true },
      });
      canSearch = memberships.some((m) =>
        hasOrgPermission(m.role, "catalog.manage"),
      );
    }

    if (!canSearch) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const query = searchParams.get("q")?.trim();
    const excludeId = searchParams.get("excludeId");

    if (!query || query.length < 1) {
      return NextResponse.json({ data: [] });
    }

    const consultants = await prisma.consultantProfile.findMany({
      where: {
        deletedAt: null,
        verificationStatus: "VERIFIED",
        ...(excludeId && { id: { not: excludeId } }),
        user: {
          OR: [
            { name: { contains: query, mode: "insensitive" } },
            { email: { contains: query, mode: "insensitive" } },
          ],
        },
      },
      select: {
        id: true,
        user: {
          select: {
            name: true,
            email: true,
            image: true,
          },
        },
      },
      take: 10,
      orderBy: { user: { name: "asc" } },
    });

    return NextResponse.json({
      data: consultants.map((c) => ({
        ...c,
        user: {
          ...c.user,
          email: maskEmail(c.user.email),
        },
      })),
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "consultants" } },
    );
    console.error("Error searching consultants:", error);
    return NextResponse.json(
      { error: "Failed to search consultants" },
      { status: 500 },
    );
  }
}
