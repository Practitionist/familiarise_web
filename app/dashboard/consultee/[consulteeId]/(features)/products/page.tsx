import { permanentRedirect } from "next/navigation";

import { consulteeLegacyHref } from "@/lib/dashboard/personal-legacy-routes";

/** Moved into the Library; the old URL answers a 308 with its query kept. */
export default async function ConsulteeProductsRedirect({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { consulteeId } = await params;
  permanentRedirect(
    consulteeLegacyHref(consulteeId, "products", await searchParams),
  );
}
