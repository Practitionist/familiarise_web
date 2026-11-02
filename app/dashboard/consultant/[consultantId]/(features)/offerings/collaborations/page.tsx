import { permanentRedirect } from "next/navigation";

import { consultantLegacyHref } from "@/lib/dashboard/personal-legacy-routes";

/** Collaborations is its own Sell page; the old URL 308s with its query kept. */
export default async function OfferingsCollaborationsRedirect({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { consultantId } = await params;
  permanentRedirect(
    consultantLegacyHref(
      consultantId,
      "offerings/collaborations",
      await searchParams,
    ),
  );
}
