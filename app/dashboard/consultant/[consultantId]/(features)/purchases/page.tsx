import { permanentRedirect } from "next/navigation";

import { consultantLegacyHref } from "@/lib/dashboard/personal-legacy-routes";

/** Moved into My library; the old URL answers a 308 with its query kept. */
export default async function ConsultantPurchasesRedirect({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { consultantId } = await params;
  permanentRedirect(
    consultantLegacyHref(consultantId, "purchases", await searchParams),
  );
}
