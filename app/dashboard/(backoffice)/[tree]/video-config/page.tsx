import { requireBackofficePage } from "@/lib/auth-guard";
import VideoConfigPageClient from "@/components/dashboard/backoffice/VideoConfigPageClient";

export default async function BackofficeVideoConfigPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("videoConfig.manage", (await params).tree);
  return <VideoConfigPageClient />;
}
