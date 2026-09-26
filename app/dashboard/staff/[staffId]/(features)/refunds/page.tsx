import { permanentRedirect } from "next/navigation";

import { moneyHubHref } from "@/lib/backoffice/money-tabs";

/** #1771 K-2 — refunds moved into the Money hub; the old URL answers a 308. */
export default async function StaffRefundsRedirectPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ staffId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { staffId } = await params;
  permanentRedirect(
    moneyHubHref(`/dashboard/staff/${staffId}`, "refunds", await searchParams),
  );
}
