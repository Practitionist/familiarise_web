import { permanentRedirect } from "next/navigation";

import { moneyHubHref } from "@/lib/backoffice/money-tabs";

/** #1771 K-2 — disputes moved into the Money hub; the old URL answers a 308. */
export default async function AdminDisputesRedirectPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  permanentRedirect(
    moneyHubHref("/dashboard/admin", "disputes", await searchParams),
  );
}
