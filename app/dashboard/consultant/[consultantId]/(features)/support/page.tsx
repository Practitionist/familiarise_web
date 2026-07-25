import { SupportSurface } from "@/components/dashboard/shared/support/SupportSurface";

/**
 * Consultant Support — requests, feedback, and help in one place.
 * Was `/help`: a static FAQ reachable only from the avatar dropdown, with no
 * way to raise a request or leave feedback.
 */
export default async function ConsultantSupportPage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  const { consultantId } = await params;
  return <SupportSurface profileId={consultantId} />;
}
