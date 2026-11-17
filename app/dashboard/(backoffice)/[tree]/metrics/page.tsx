import { requireBackofficePage } from "@/lib/auth-guard";
import MetricsPageClient from "./MetricsPageClient";

/** Metrics: support-queue health and the platform totals, in both trees. */
export default async function Page({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("analytics.read", (await params).tree);
  return <MetricsPageClient />;
}
