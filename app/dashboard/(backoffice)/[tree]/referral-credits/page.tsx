import { requireBackofficePage } from "@/lib/auth-guard";
import ReferralCreditsPageClient from "@/components/dashboard/backoffice/referrals/ReferralCreditsPageClient";

export default async function BackofficeReferralCreditsPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("referrals.read", (await params).tree);
  return <ReferralCreditsPageClient />;
}
