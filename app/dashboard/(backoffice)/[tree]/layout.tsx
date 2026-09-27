import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { BackofficeCapabilityProvider } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { OperatorDashboardShell } from "@/components/dashboard/OperatorDashboardShell";
import { requireUserRole } from "@/lib/auth-guard";
import {
  isBackofficeTree,
  resolveBackofficeCapability,
} from "@/lib/backoffice/capability";
import { staffTwinHref } from "@/lib/backoffice/legacy-routes";
import { ENABLE_TDS_ADMIN_VIEW } from "@/lib/feature-flags";

/**
 * #1527 Q3 — one layout for both back-office trees. The tree segment is
 * checked BEFORE any role check so `/dashboard/<anything else>` 404s for
 * every viewer, then only ADMIN/STAFF pass. STAFF opening the admin tree get
 * the same page in theirs. Access is still re-checked per page
 * (`requireBackofficePage`): this layout doesn't re-run on client navigation.
 */
export default async function BackofficeLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ tree: string }>;
}>) {
  const { tree } = await params;
  if (!isBackofficeTree(tree)) notFound();

  const session = await requireUserRole(["ADMIN", "STAFF"]);
  const cap = resolveBackofficeCapability(session.user.role, tree);
  if (!cap) {
    // Only STAFF on the admin tree reach here; middleware sets x-pathname.
    redirect(staffTwinHref((await headers()).get("x-pathname")));
  }

  return (
    <BackofficeCapabilityProvider value={cap} viewerId={session.user.id}>
      <OperatorDashboardShell
        userName={session.user.name ?? null}
        userImage={session.user.image ?? null}
        // #863 — the TDS page 404s while the flag is off; hide its nav item.
        showTds={ENABLE_TDS_ADMIN_VIEW}
      >
        {children}
      </OperatorDashboardShell>
    </BackofficeCapabilityProvider>
  );
}
