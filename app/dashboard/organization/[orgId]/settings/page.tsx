import { notFound, redirect } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { accountSettingsHref } from "@/lib/dashboard/account-href";
import {
  orgSettingsHref,
  orgSettingsSectionsFor,
} from "@/lib/dashboard/org-settings-sections";

/**
 * /dashboard/organization/[orgId]/settings (#1527) has no body: it sends the
 * viewer to a section — a retired `?tab=<key>` to that section, otherwise the
 * first one the role may open. `?tab=notifications` goes to the viewer's own
 * Settings › Notifications, where it moved. `?view=sections` is the mobile
 * list the layout renders.
 */
export default async function OrgSettingsPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { orgId } = await params;
  const sp = await searchParams;
  const access = await requireOrgAccess(orgId, { readOnly: true });
  if (access.error) notFound();

  const tab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  if (tab === "notifications") {
    redirect(
      accountSettingsHref(access.session.user, "notifications") ??
        `/dashboard/organization/${orgId}/home`,
    );
  }
  const sections = orgSettingsSectionsFor(access.member.role);
  if (sections.length === 0) redirect(`/dashboard/organization/${orgId}/home`);
  if (sp.view === "sections") return null;
  const target = sections.find((s) => s.key === tab) ?? sections[0];
  redirect(orgSettingsHref(orgId, target.key));
}
