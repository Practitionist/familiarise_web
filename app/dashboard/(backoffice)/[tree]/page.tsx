import { notFound, redirect } from "next/navigation";

import {
  backofficeLandingHref,
  isBackofficeTree,
} from "@/lib/backoffice/capability";

/** Bare `/dashboard/<tree>` opens the tree's landing (Q12). */
export default async function BackofficeTreeIndex({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  const { tree } = await params;
  if (!isBackofficeTree(tree)) notFound();
  redirect(backofficeLandingHref({ tree }));
}
