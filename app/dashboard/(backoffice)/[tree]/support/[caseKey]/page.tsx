import { notFound, redirect } from "next/navigation";

import { CaseWorkspace } from "@/components/dashboard/backoffice/support/CaseWorkspace";
import { articleLinksByTopic } from "@/app/support/_data/support-content";
import { requireBackofficePage } from "@/lib/auth-guard";
import { caseKeyOf, parseCaseKey } from "@/lib/support/case-key";
import { escalatedTicketOf } from "@/lib/support/case-workspace";

/**
 * #1527 — one support case (`t_<ticketId>` or `s_<threadId>`), beside the
 * inbox list at lg+. Its own URL, so deep links, refresh and Back work.
 */
export default async function SupportCasePage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ tree: string; caseKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { tree, caseKey } = await params;
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  const { cap } = await requireBackofficePage("tickets.manage", tree);
  const ref = parseCaseKey(caseKey);
  if (!ref || ref.kind === "booking") notFound();
  // An escalated conversation is one case — its ticket — so an older `s_`
  // link (a notification, the retired Conversations URL) opens that.
  const ticketId =
    ref.kind === "thread" ? await escalatedTicketOf(ref.id) : null;
  if (ticketId) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(await searchParams)) {
      if (typeof value === "string") query.set(key, value);
    }
    const qs = query.toString();
    redirect(
      `${cap.basePath}/support/${caseKeyOf({ kind: "ticket", id: ticketId })}${qs ? `?${qs}` : ""}`,
    );
  }
  // Help Center data stays on the server; the client gets title + href.
  return <CaseWorkspace caseKey={caseKey} articles={articleLinksByTopic()} />;
}
