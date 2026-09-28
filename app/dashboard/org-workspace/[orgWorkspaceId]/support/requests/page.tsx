import { redirect } from "next/navigation";

/** #1527 — requests are listed on Support; only each request has a page here. */
export default async function WorkspaceSupportRequestsIndex({
  params,
}: Readonly<{ params: Promise<{ orgWorkspaceId: string }> }>) {
  const { orgWorkspaceId } = await params;
  redirect(`/dashboard/org-workspace/${orgWorkspaceId}/support`);
}
