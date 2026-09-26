import { notFound } from "next/navigation";
import { requireOnboarded } from "@/lib/auth-guard";
import prisma from "@/lib/prisma";
import { OrgWorkspaceShell } from "./OrgWorkspaceShell";

/**
 * Server-side guard + chrome lift for the operator (cross-org) dashboard.
 *
 * IDOR guard: the orgWorkspaceId in the URL must match the authenticated
 * user's orgWorkspaceProfileId. We refuse to even hint that another user's
 * profile exists — URL-guessing returns the same 404 as a truly absent
 * id.
 *
 * requireOnboarded (not just requireAuth): the operator surface assumes a
 * finished onboarding (role + linked OrgWorkspaceProfile, created at the
 * ORG_WORKSPACE handoff). A mid-wizard user who guesses this URL bounces to
 * /form/onboarding instead of seeing an empty operator shell.
 *
 * Chrome: the shared DashboardShell via OrgWorkspaceShell (#1527), which
 * also owns the Novu provider — keeping the layout thin so the auth check
 * stays server-side.
 *
 * User identity props (name/image) are read from the *server*
 * session here and passed down. The shell intentionally does NOT use
 * useSession() for these — the client hook returns null on the first
 * render and resolves later, which causes a hydration mismatch when
 * the sidebar renders the displayed name.
 */
export default async function OrgWorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgWorkspaceId: string }>;
}) {
  const { orgWorkspaceId } = await params;
  const session = await requireOnboarded();

  // `orgWorkspaceProfileId` lives on the inferred Session["user"] via the
  // customSession callback (lib/auth.ts). Direct access is type-safe.
  if (session.user.orgWorkspaceProfileId !== orgWorkspaceId) {
    notFound();
  }

  // #1527 §7.4 — the portfolio pages only earn their place past one org.
  const ownedOrgCount = await prisma.membership.count({
    where: { userId: session.user.id, role: "OWNER", status: "ACTIVE" },
  });

  return (
    <OrgWorkspaceShell
      orgWorkspaceId={orgWorkspaceId}
      ownedOrgCount={ownedOrgCount}
      userName={session.user.name ?? null}
      userImage={session.user.image ?? null}
    >
      {children}
    </OrgWorkspaceShell>
  );
}
