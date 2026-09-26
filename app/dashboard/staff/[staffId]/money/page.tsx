import { permanentRedirect } from "next/navigation";

/** #1771 K-2 — the staff Money hub opens on Payments. */
export default async function StaffMoneyPage({
  params,
}: Readonly<{ params: Promise<{ staffId: string }> }>) {
  const { staffId } = await params;
  permanentRedirect(`/dashboard/staff/${staffId}/money/payments`);
}
