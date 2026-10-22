import { notFound } from "next/navigation";

import { CaseWorkspace } from "@/components/dashboard/backoffice/support/CaseWorkspace";
import {
  articleLinksByTopic,
  helpCenterArticleLinks,
} from "@/app/support/_data/support-content";
import { requireBackofficePage } from "@/lib/auth-guard";
import { parseCaseKey } from "@/lib/support/case-key";

/** A canonical case workspace with its own refreshable URL. */
export default async function SupportCasePage({
  params,
}: Readonly<{
  params: Promise<{ tree: string; caseKey: string }>;
}>) {
  const { tree, caseKey } = await params;
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("tickets.manage", tree);
  const ref = parseCaseKey(caseKey);
  if (!ref || ref.kind === "booking") notFound();
  // Help Center data stays on the server; the client gets title + href.
  return (
    <CaseWorkspace
      caseKey={caseKey}
      articles={articleLinksByTopic()}
      helpArticles={helpCenterArticleLinks()}
    />
  );
}
