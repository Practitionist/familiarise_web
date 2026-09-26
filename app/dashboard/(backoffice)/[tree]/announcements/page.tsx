import { AnnouncementsPage } from "@/components/dashboard/shared/AnnouncementsPage";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function BackofficeAnnouncementsPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("announcements.manage", (await params).tree);
  return <AnnouncementsPage queryKeyPrefix="admin-announcements" />;
}
