import { redirect } from "next/navigation";

import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { orgRoleSatisfies } from "@/lib/auth-helpers";
import { resolvePersonalDashboardHref } from "@/lib/labels/personal-dashboard";

/**
 * Bare /[orgId] route.
 *
 * Operators (MANAGER+) land on /home — the org overview. Consumer
 * roles (LEARNER, EXPERT, SUPPORT) aren't operators; they're routed
 * to their personal dashboard via resolvePersonalDashboardHref so
 * they don't see a broken operator view. Platform ADMINs and any
 * user with no membership row fall through to the default redirect.
 */
export default async function OrgRoot({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const session = await getSession(true);
  if (!session?.user?.id) redirect("/auth/signin");

  // ADMINs bypass membership checks elsewhere (lib/auth-helpers.ts
  // synthesizes an OWNER stub). Keep their /home path intact.
  if (session.user.role !== "ADMIN") {
    const member = await prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: session.user.id,
          organizationId: orgId,
        },
      },
      select: { role: true, status: true },
    });

    if (
      member?.status === "ACTIVE" &&
      !orgRoleSatisfies(member.role, "MANAGER")
    ) {
      // Resolver returns null if the user has no personal profile yet
      // (e.g. a LEARNER whose ConsulteeProfile is still lazy per
      // lib/profiles/ensure-consultee-profile.ts). Fall back to /dashboard
      // which routes by role on the client.
      redirect(resolvePersonalDashboardHref(session.user) ?? "/dashboard");
    }
  }

  redirect(`/dashboard/organization/${orgId}/home`);
}
