import { permanentRedirect } from "next/navigation";

/**
 * /settings/payouts moved into the Settings hub as "Get paid" (#1785 L-2).
 * The earnings page, the Home setup row and the payout-requirements helper
 * still link here, so the old URL answers a 308 rather than a 404.
 */
export default async function PayoutsRedirectPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  permanentRedirect(`/dashboard/consultant/${consultantId}/settings/get-paid`);
}
