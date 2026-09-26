import { SupportThreadsPage } from "@/components/dashboard/shared/SupportThreadsPage";
import { requireBackofficePage } from "@/lib/auth-guard";

/** #support-hub — per-appointment conversation inbox, for both trees. */
export default async function BackofficeSupportThreadsPageRoute({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("threads.manage", (await params).tree);
  return <SupportThreadsPage />;
}
