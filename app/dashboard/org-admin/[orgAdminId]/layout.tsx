import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth-guard";

/**
 * Guard for the operator-side personal dashboard.
 *
 * The orgAdminId in the URL must match the authenticated user's
 * orgAdminProfileId. We refuse to even hint that another user's
 * profile exists — IDOR by URL-guessing returns the same 404 as
 * a truly absent id.
 *
 * We deliberately do NOT render a sidebar/shell here. The operator
 * dashboard today is a thin redirect/chooser page. When we grow
 * actual operator-only surfaces (preferences, activity feed, billing
 * overview across orgs), revisit this to lift a proper
 * CollapsibleSidebar like /dashboard/staff has.
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

  return <>{children}</>;
}
