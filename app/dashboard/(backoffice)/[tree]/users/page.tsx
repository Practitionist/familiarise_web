import { OperatorUsersPage } from "@/components/dashboard/shared/OperatorUsersPage";
import { requireBackofficePage } from "@/lib/auth-guard";

/** User directory + verification queue, for both trees. */
export default async function BackofficeOperatorUsersPageRoute({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("users.read", (await params).tree);
  return <OperatorUsersPage />;
}
