import { redirect } from "next/navigation";

import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { resolvePersonalDashboardHref } from "@/lib/labels/personal-dashboard";

/**
 * Bare /[orgId] route.
 *
 * Routing by role and org capability (ORG-19, #1527):
 *   - MANAGER+      → /home (operator overview)
 *   - LEARNER       → /my-program in a sponsoring org, else /appointments
 *   - EXPERT        → /compensation in a hosting org, else /appointments
 *   - SUPPORT       → /home (read-only operator views; rank-30 passes
 *                    role checks on the lighter pages)
 *   - no membership → personal dashboard fallback (resolver may return
 *                     null if no profile yet — final default is
 *                     /dashboard which routes by role on the client)
 *
 * Platform ADMINs are role-stubbed as OWNER by `requireOrgAccess`
 * elsewhere; they always pass through to /home.
 */
export default async function OrgRoot({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const session = await getSession(true);
  if (!session?.user?.id) redirect("/auth/signin");

  if (session.user.role !== "ADMIN") {
    const member = await prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: session.user.id,
          organizationId: orgId,
        },
      },
      select: {
        role: true,
        status: true,
        organization: { select: { canSponsor: true, canHost: true } },
      },
    });

    if (member?.status === "ACTIVE") {
      const base = `/dashboard/organization/${orgId}`;
      // Those pages need the capability; without it they'd bounce to home.
      if (member.role === "LEARNER") {
        redirect(
          member.organization.canSponsor
            ? `${base}/my-program`
            : `${base}/appointments`,
        );
      }
      if (member.role === "EXPERT") {
        redirect(
          member.organization.canHost
            ? `${base}/compensation`
            : `${base}/appointments`,
        );
      }
      // MANAGER+, SUPPORT, OWNER, MAINTAINER fall through to /home
    } else if (!member) {
      // No membership — bounce out entirely. resolvePersonalDashboardHref
      // may return null if the user has no personal profile yet.
      redirect(resolvePersonalDashboardHref(session.user) ?? "/dashboard");
    }
  }

  redirect(`/dashboard/organization/${orgId}/home`);
}
