import { notFound, redirect } from "next/navigation";

import { SupportRequestView } from "@/components/dashboard/shared/support/SupportRequestView";
import { requireOnboarded } from "@/lib/auth-guard";
import { caseKeyOf, parseCaseKey } from "@/lib/support/case-key";
import { readOwnTicket } from "@/lib/support/own-case-read";
import { articleLinksByTopic } from "../_data/support-content";

/**
 * #1527 — one support request's page, shared by every dashboard that mounts
 * Support requests. Lives in app/ because the suggested articles read Help
 * Center data. A ticket must be the viewer's own; an escalated session
 * request opens on its conversation's page, which is where the user talks.
 */
export async function SupportRequestCasePage({
  caseKey,
  supportHref,
  requestsBase = `${supportHref}/requests`,
  appointmentsBase,
  paymentsBase,
  intent,
}: Readonly<{
  caseKey: string;
  /** The dashboard's Support requests page. */
  supportHref: string;
  /** Where request pages live; defaults to `<supportHref>/requests`. */
  requestsBase?: string;
  appointmentsBase?: string;
  paymentsBase?: string;
  intent?: string | string[];
}>) {
  const ref = parseCaseKey(caseKey);
  if (!ref || ref.kind === "thread") notFound();
  if (ref.kind === "ticket" || ref.kind === "case") {
    const { user } = await requireOnboarded();
    const own = await readOwnTicket(ref.id, user.id);
    if (!own) notFound();
    if (own.appointmentId) {
      redirect(
        `${requestsBase}/${caseKeyOf({ kind: "booking", id: own.appointmentId })}`,
      );
    }
  }
  return (
    <SupportRequestView
      caseKey={caseKey}
      requestsHref={supportHref}
      appointmentsBase={appointmentsBase}
      paymentsBase={paymentsBase}
      intent={typeof intent === "string" ? intent : undefined}
      articles={articleLinksByTopic()}
    />
  );
}

/** The personal trees' request page body: consultee and consultant alike. */
export function PersonalSupportRequestPage({
  tree,
  profileId,
  caseKey,
  intent,
}: Readonly<{
  tree: "consultee" | "consultant";
  profileId: string;
  caseKey: string;
  intent?: string | string[];
}>) {
  const base = `/dashboard/${tree}/${profileId}`;
  return (
    <SupportRequestCasePage
      caseKey={caseKey}
      supportHref={`${base}/support`}
      appointmentsBase={`${base}/appointments`}
      // Payment pages exist only in the consultee tree.
      paymentsBase={tree === "consultee" ? `${base}/payments` : undefined}
      intent={intent}
    />
  );
}
