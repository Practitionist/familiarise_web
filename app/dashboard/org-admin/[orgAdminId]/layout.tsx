import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth-guard";
import NovuProvider from "@/providers/NovuProvider";
import { OrgSwitcherTopBar } from "@/components/dashboard/OrgSwitcherTopBar";

/**
 * Guard + slim chrome for the operator-side personal dashboard.
 *
 * IDOR guard: the orgAdminId in the URL must match the authenticated
 * user's orgAdminProfileId. We refuse to even hint that another
 * user's profile exists — URL-guessing returns the same 404 as a
 * truly absent id.
 *
 * Chrome: a 64px slim top-bar (back link, OrganizationSwitcher,
 * NotificationInbox, user menu). Previously this layout was a noop,
 * which left the operator chooser page stranded. The back link is
 * suppressed (`hideBackLink`) because the resolver would route the
 * user right back to this same operator dashboard, creating a loop.
 *
 * The full per-org CollapsibleSidebar lives one level deeper, on
 * /dashboard/organization/[orgId]/layout.tsx — once the operator
 * picks an org, they get the rich sidebar.
 */
export default async function OrgAdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgAdminId: string }>;
}) {
  const { orgAdminId } = await params;
  const session = await requireAuth();

  const sessionUser = session.user as typeof session.user & {
    orgAdminProfileId?: string | null;
  };
  if (sessionUser.orgAdminProfileId !== orgAdminId) {
    notFound();
  }

  return (
    <NovuProvider>
      <div className="flex h-screen-maintenance flex-col bg-zinc-50 dark:bg-zinc-950">
        <OrgSwitcherTopBar hideBackLink />
        <main className="flex-1 overflow-y-auto">
          <div className="p-6">{children}</div>
        </main>
      </div>
    </NovuProvider>
  );
}
