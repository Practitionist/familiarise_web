import { OperatorUsersPage } from "@/components/dashboard/shared/OperatorUsersPage";
import { requireBackofficePage } from "@/lib/auth-guard";

/** User directory + verification queue — shared with the staff tree. */
export default async function AdminUsersPage() {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("users.read");
  return <OperatorUsersPage />;
}
