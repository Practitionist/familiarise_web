import { redirect } from "next/navigation";

/**
 * /dashboard/org-workspace/[id]/settings (#1527) has no body: it opens the
 * first section, except `?view=sections` (the mobile list the layout renders).
 */
export default async function OrgWorkspaceSettingsPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ orgWorkspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { orgWorkspaceId } = await params;
  if ((await searchParams).view === "sections") return null;
  redirect(`/dashboard/org-workspace/${orgWorkspaceId}/settings/landing`);
}
