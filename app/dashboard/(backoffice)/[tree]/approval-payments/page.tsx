import { requireBackofficePage } from "@/lib/auth-guard";
import ApprovalPaymentsPageClient from "./ApprovalPaymentsPageClient";

/** Approved bookings awaiting payment. */
export default async function Page({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("approvalPayments.manage", (await params).tree);
  return <ApprovalPaymentsPageClient />;
}
