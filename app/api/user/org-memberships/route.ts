/**
 * GET /api/user/org-memberships
 *
 * #support-hub — the signed-in user's ACTIVE organization memberships, so the
 * Support hub's session picker can merge org-hosted sessions (personal scope
 * pins `organizationId: null` by design, ADR 19) and tag them with the org
 * name. Read-only, session-keyed, no content.
 *
 * `?all=1` (#1527) — the context switcher also lists PENDING/SUSPENDED
 * memberships and orgs awaiting verification or suspended, which the session
 * deliberately omits (widening it would cost a read on every request). It is
 * fetched only when the switcher opens. Removed/erased memberships and
 * deactivated orgs stay out: there is no dashboard behind them.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { supportError } from "@/lib/api/support-http";

const MEMBERSHIPS_ROUTE = "user.org-memberships";

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return supportError({ status: 401, code: "UNAUTHORIZED" });
    }

    const all = request.nextUrl.searchParams.get("all") === "1";
    const memberships = await prisma.membership.findMany({
      where: all
        ? {
            userId: session.user.id,
            status: { in: ["ACTIVE", "PENDING", "SUSPENDED"] },
            organization: { status: { not: "DEACTIVATED" } },
          }
        : { userId: session.user.id, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: {
        organizationId: true,
        role: true,
        status: true,
        organization: {
          select: {
            name: true,
            status: true,
            brandingProfile: { select: { logo: true } },
          },
        },
      },
    });

    return NextResponse.json(
      {
        data: memberships.map((m) => ({
          organizationId: m.organizationId,
          orgName: m.organization.name,
          orgLogo: m.organization.brandingProfile?.logo ?? null,
          orgStatus: m.organization.status,
          role: m.role,
          status: m.status,
        })),
      },
      // Per-user payload: never shared by a CDN or reused across sessions.
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: MEMBERSHIPS_ROUTE, action: "list" },
    });
  }
}
