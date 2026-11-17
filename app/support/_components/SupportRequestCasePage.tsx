import { notFound } from "next/navigation";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";

import { SupportRequestView } from "@/components/dashboard/shared/support/SupportRequestView";
import { requireOnboarded } from "@/lib/auth-guard";
import { parseCaseKey } from "@/lib/support/case-key";
import { readOwnSupportCase } from "@/lib/support/own-case-read";
import { supportKeys } from "@/lib/support/support-keys";
import { articleLinksByTopic } from "../_data/support-content";

/**
 * One support request's page, shared by every dashboard. A case must be the
 * viewer's own; its read is hydrated so the first paint has the conversation.
 */
export async function SupportRequestCasePage({
  caseKey,
  supportHref,
  appointmentsBase,
  paymentsBase,
  intent,
}: Readonly<{
  caseKey: string;
  /** The dashboard's Support requests page. */
  supportHref: string;
  appointmentsBase?: string;
  paymentsBase?: string;
  intent?: string | string[];
}>) {
  const ref = parseCaseKey(caseKey);
  if (!ref) notFound();
  const view = (
    <SupportRequestView
      caseKey={caseKey}
      requestsHref={supportHref}
      appointmentsBase={appointmentsBase}
      paymentsBase={paymentsBase}
      intent={typeof intent === "string" ? intent : undefined}
      articles={articleLinksByTopic()}
    />
  );
  if (ref.kind === "booking") return view;
  const { user } = await requireOnboarded();
  const own = await readOwnSupportCase(ref.id, user.id);
  if (!own) notFound();
  // Same key and shape as GET /api/support/requests/c_<id>.
  const queryClient = new QueryClient();
  queryClient.setQueryData(supportKeys.ownCase(ref.id), own);
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>{view}</HydrationBoundary>
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
