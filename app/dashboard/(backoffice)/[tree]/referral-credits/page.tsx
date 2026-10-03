import AdminReferralCreditsPage from "@/app/dashboard/admin/referral-credits/page";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function BackofficeReferralCreditsPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("referrals.read", (await params).tree);
  return <AdminReferralCreditsPage />;
}
