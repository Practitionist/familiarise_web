import { notFound, permanentRedirect } from "next/navigation";

import { isBackofficeTree } from "@/lib/backoffice/capability";
import { moneyHubHref } from "@/lib/backoffice/money-tabs";

/** #1771 K-2 — payouts moved into the Money hub; the old URL answers a 308. */
export default async function BackofficePayoutsRedirectPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ tree: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { tree } = await params;
  if (!isBackofficeTree(tree)) notFound();
  permanentRedirect(
    moneyHubHref(`/dashboard/${tree}`, "payouts", await searchParams),
  );
}
