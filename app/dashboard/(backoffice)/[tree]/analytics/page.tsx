import { requireBackofficePage } from "@/lib/auth-guard";
import AnalyticsPageClient from "./AnalyticsPageClient";

/** Platform analytics — admin's Insights item (staff read Metrics). */
export default async function Page({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("analytics.read", (await params).tree);
  return <AnalyticsPageClient />;
}
