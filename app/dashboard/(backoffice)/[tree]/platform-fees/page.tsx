import { requireBackofficePage } from "@/lib/auth-guard";
import { PlatformFeesPageClient } from "@/components/dashboard/backoffice/fees/PlatformFeesPageClient";

/** The platform take-rate schedules: read on `payments.read`, proposed and approved on `payments.manage`. */
export default async function BackofficePlatformFeesPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("payments.read", (await params).tree);
  return <PlatformFeesPageClient />;
}
