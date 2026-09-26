import { WaitlistManagement } from "@/components/admin/WaitlistManagement";
import { requireBackofficePage } from "@/lib/auth-guard";

/** Newsletter list (#1527: label renamed; the URL stays `waitlist`). */
export default async function BackofficeWaitlistPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("waitlist.manage", (await params).tree);
  return <WaitlistManagement />;
}
