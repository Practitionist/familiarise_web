import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth-guard";
import prisma from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Building2 } from "lucide-react";

/**
 * Operator-side personal dashboard home.
 *
 * Routing behaviour:
 *   - 1 OWNER membership  -> redirect straight into that org's dashboard.
 *   - 2+ OWNER memberships -> render a chooser. Clicking one lands on
 *                             that org's /home.
 *   - 0 OWNER memberships -> CTA to create an organization. Happens when
 *                            an OrgAdminProfile exists (e.g. from a
 *                            previously-deactivated org) but the user
 *                            has no active ownership today.
 *
 * The "Personal Dashboard" link in the org sidebar always targets this
 * page via resolvePersonalDashboardHref; for single-org operators the
 * redirect here is the reason the link feels like "just switch back to
 * my org". Multi-org operators see a deliberate chooser because there's
 * no sensible default.
 */
export default async function OrgAdminHomePage() {
  const session = await requireAuth();

  const ownedMemberships = await prisma.membership.findMany({
    where: {
      userId: session.user.id,
      role: "OWNER",
      status: "ACTIVE",
    },
    select: {
      organizationId: true,
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          status: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  if (ownedMemberships.length === 1) {
    redirect(
      `/dashboard/organization/${ownedMemberships[0].organizationId}/home`,
    );
  }

  if (ownedMemberships.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-zinc-50 p-6">
        <Card className="max-w-lg w-full">
          <CardHeader>
            <CardTitle>No organizations yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-zinc-600">
              You don&apos;t currently own an active organization. Create
              one to get started — you&apos;ll be able to invite members,
              set up billing, and configure your workspace from there.
            </p>
            <Button asChild>
              <Link href="/dashboard/organization/create">
                Create an organization
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900">
            Your organizations
          </h1>
          <p className="text-sm text-zinc-600 mt-1">
            You own {ownedMemberships.length} organizations. Pick one to
            open its dashboard.
          </p>
        </div>

        <div className="grid gap-3">
          {ownedMemberships.map((m) => (
            <Link
              key={m.organizationId}
              href={`/dashboard/organization/${m.organizationId}/home`}
              className="block"
            >
              <Card className="hover:border-zinc-400 transition-colors">
                <CardContent className="flex items-center gap-4 py-4">
                  <div className="w-10 h-10 rounded-md bg-zinc-100 flex items-center justify-center shrink-0">
                    <Building2 className="w-5 h-5 text-zinc-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-zinc-900 truncate">
                      {m.organization.name}
                    </div>
                    <div className="text-xs text-zinc-500 truncate">
                      {m.organization.slug}
                      {m.organization.status !== "ACTIVE" && (
                        <span className="ml-2 text-amber-600">
                          · {m.organization.status.toLowerCase()}
                        </span>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
