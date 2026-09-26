import { requireBackofficePage } from "@/lib/auth-guard";
import MetricsPageClient from "./MetricsPageClient";

/** Support-queue metrics — staff's Insights item (#1527: moved from the staff tree). */
export default async function Page({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("analytics.read", (await params).tree);
  return <MetricsPageClient />;
}
