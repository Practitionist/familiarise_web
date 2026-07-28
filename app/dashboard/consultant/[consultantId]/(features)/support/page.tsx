import { SupportRequestsPage } from "@/components/dashboard/shared/support/SupportPages";

/**
 * Support requests. Feedback and Help are sibling entries now rather than tabs
 * here — see SupportPages for why.
 */
export default async function SupportPage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  const p = await params;
  return <SupportRequestsPage profileId={p.consultantId} />;
}
