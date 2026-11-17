import { notFound, permanentRedirect } from "next/navigation";

import { isBackofficeTree } from "@/lib/backoffice/capability";

/** The disputes list lives on the Money hub; the detail page's parent crumb lands there. */
export default async function BackofficeDisputesParent({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  const { tree } = await params;
  if (!isBackofficeTree(tree)) notFound();
  permanentRedirect(`/dashboard/${tree}/money/disputes`);
}
