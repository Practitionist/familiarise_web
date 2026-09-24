import { TicketsPage } from "@/components/dashboard/shared/TicketsPage";
import { requireBackofficePage } from "@/lib/auth-guard";

/** Support ticket queue — shared with the admin tree. */
export default async function StaffTicketsPage() {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("tickets.manage");
  return <TicketsPage />;
}
