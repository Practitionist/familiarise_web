import { permanentRedirect } from "next/navigation";

import { offeringsListLegacyHref } from "@/lib/dashboard/personal-legacy-routes";

/** Split into the Sell pages; `?type=` picks the page and tab, the rest is kept. */
export default async function OfferingsRedirect({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { consultantId } = await params;
  permanentRedirect(offeringsListLegacyHref(consultantId, await searchParams));
}
