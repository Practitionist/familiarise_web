import { redirect } from "next/navigation";

/** #1527 — requests are listed on Support; only each request has a page here. */
export default async function OrgSupportRequestsIndex({
  params,
}: Readonly<{ params: Promise<{ orgId: string }> }>) {
  const { orgId } = await params;
  redirect(`/dashboard/organization/${orgId}/support`);
}
