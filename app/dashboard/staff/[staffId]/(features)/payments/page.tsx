import { permanentRedirect } from "next/navigation";

import { moneyHubHref } from "@/lib/backoffice/money-tabs";

/** #1771 K-2 — payments moved into the Money hub; the old URL answers a 308. */
export default async function StaffPaymentsRedirectPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ staffId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { staffId } = await params;
  permanentRedirect(
    moneyHubHref(`/dashboard/staff/${staffId}`, "payments", await searchParams),
  );
}
