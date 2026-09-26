import { notFound, permanentRedirect } from "next/navigation";

import { isBackofficeTree } from "@/lib/backoffice/capability";
import { legacyBackofficeHref } from "@/lib/backoffice/legacy-routes";

/** #1527 Q3 — retired back-office URLs answer a 308; anything else 404s. */
export default async function LegacyBackofficeRedirect({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ tree: string; legacy: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { tree, legacy } = await params;
  if (!isBackofficeTree(tree)) notFound();
  const target = legacyBackofficeHref(tree, legacy, await searchParams);
  if (!target) notFound();
  permanentRedirect(target);
}
