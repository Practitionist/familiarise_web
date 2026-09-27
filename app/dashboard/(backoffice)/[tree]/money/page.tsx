import { notFound, permanentRedirect } from "next/navigation";

import { isBackofficeTree } from "@/lib/backoffice/capability";

/** #1771 K-2 — the hub has no body of its own; it opens on Payments. */
export default async function BackofficeMoneyPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  const { tree } = await params;
  if (!isBackofficeTree(tree)) notFound();
  permanentRedirect(`/dashboard/${tree}/money/payments`);
}
