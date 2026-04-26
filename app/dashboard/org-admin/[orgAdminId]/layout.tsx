import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth-guard";
import NovuProvider from "@/providers/NovuProvider";
import { OrgAdminShell } from "./OrgAdminShell";

/**
 * Server-side guard + chrome lift for the operator (cross-org) dashboard.
 *
 * IDOR guard: the orgAdminId in the URL must match the authenticated
 * user's orgAdminProfileId. We refuse to even hint that another user's
 * profile exists — URL-guessing returns the same 404 as a truly absent
 * id.
 *
 * Chrome: full CollapsibleSidebar (mirrors /dashboard/admin and
 * /dashboard/staff), with a top context bar carrying the
 * OrganizationSwitcher dropdown and the Novu notification bell. The
 * sidebar items live on OrgAdminShell — keeping the layout thin so
 * the auth check stays server-side.
 *
 * User identity props (name/email/image) are read from the *server*
 * session here and passed down. The shell intentionally does NOT use
 * useSession() for these — the client hook returns null on the first
 * render and resolves later, which causes a hydration mismatch when
 * the sidebar renders the displayed name.
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

  // `orgAdminProfileId` lives on the inferred Session["user"] via the
  // customSession callback (lib/auth.ts:522). Direct access is type-safe.
  if (session.user.orgAdminProfileId !== orgAdminId) {
    notFound();
  }

  return (
    <NovuProvider>
      <OrgAdminShell
        orgAdminId={orgAdminId}
        userName={session.user.name ?? null}
        userEmail={session.user.email ?? null}
        userImage={session.user.image ?? null}
      >
        {children}
      </OrgAdminShell>
    </NovuProvider>
  );
}
