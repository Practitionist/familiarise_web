import { SubscriptionsPage } from "@/components/dashboard/shared/SubscriptionsPage";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function BackofficeSubscriptionsPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("subscriptions.read", (await params).tree);
  return (
    <SubscriptionsPage
      apiEndpoint="/api/admin/subscriptions"
      title="Subscriptions"
      description="Platform subscription appointments"
    />
  );
}
