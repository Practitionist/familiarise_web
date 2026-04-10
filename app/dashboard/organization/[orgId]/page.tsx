import { redirect } from "next/navigation";

/**
 * Bare /[orgId] route — server-side redirect to /home so the URL stays clean.
 */
export default async function OrgRoot({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  redirect(`/dashboard/organization/${orgId}/home`);
}
