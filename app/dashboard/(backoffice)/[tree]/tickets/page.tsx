import { TicketsPage } from "@/components/dashboard/shared/TicketsPage";
import { requireBackofficePage } from "@/lib/auth-guard";

/** Support ticket queue, for both trees. */
export default async function BackofficeTicketsPageRoute({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("tickets.manage", (await params).tree);
  return <TicketsPage />;
}
