/**
 * GET /api/user/dashboard-facets
 *
 * The dashboards the signed-in user can switch to, resolved with the same
 * inputs and gates as the dashboard ContextSwitcher (session profiles plus
 * every non-deactivated membership). Fetched when the public account menu opens.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { supportError } from "@/lib/api/support-http";
import { findSwitcherMemberships } from "@/lib/dashboard/switcher-memberships";
import { resolveDashboardFacets } from "@/lib/labels/personal-dashboard";
import { canAddConsultantIdentity } from "@/utils/onboarding-shared";
import {
  DashboardFacetsResponseSchema,
  type DashboardFacetsResponse,
} from "@/lib/navigation/dashboard-facets-schema";

const ROUTE = "user.dashboard-facets";

export async function GET() {
  try {
    const session = await getSession();
    const user = session?.user;
    if (!user?.id) return supportError({ status: 401, code: "UNAUTHORIZED" });

    const rows = await findSwitcherMemberships(user.id, true);
    const facets = resolveDashboardFacets({
      role: user.role,
      canBecomeExpert: canAddConsultantIdentity({
        role: user.role,
        onboardingCompleted: user.onboardingCompleted,
        consultantProfileId: user.consultantProfileId,
      }),
      consultantProfileId: user.consultantProfileId,
      consulteeProfileId: user.consulteeProfileId,
      orgWorkspaceProfileId: user.orgWorkspaceProfileId,
      staffProfileId: user.staffProfileId,
      memberships: rows.map((m) => ({
        organizationId: m.organizationId,
        organizationName: m.organization.name,
        organizationLogo: m.organization.brandingProfile?.logo ?? null,
        role: m.role,
        status: m.status,
        orgStatus: m.organization.status,
      })),
    });

    const body: DashboardFacetsResponse = DashboardFacetsResponseSchema.parse({
      facets: [...facets.you, ...facets.organizations, ...facets.platform].map(
        ({ kind, key, label, href }) => ({ kind, key, label, href }),
      ),
    });
    // Per-user payload: never shared by a CDN or reused across sessions.
    return NextResponse.json(body, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: ROUTE, action: "list" },
    });
  }
}
