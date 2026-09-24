import { ModerationPage } from "@/components/dashboard/shared/ModerationPage";
import { requireBackofficePage } from "@/lib/auth-guard";

/** Content moderation — shared with the staff tree; see the component. */
export default async function AdminModerationPage() {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("moderation.manage");
  return <ModerationPage />;
}
