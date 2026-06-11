import { BillingPageClient } from "./BillingPageClient";

export default async function OrgBillingPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  return <BillingPageClient orgId={orgId} />;
}
