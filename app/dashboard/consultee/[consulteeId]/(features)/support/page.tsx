import { SupportSurface } from "@/components/dashboard/shared/support/SupportSurface";

/**
 * Consultee Support — requests, feedback, and help in one place.
 * Was `/feedback` (labelled "Support" in the nav, with no help content).
 */
export default async function ConsulteeSupportPage({
  params,
}: {
  params: Promise<{ consulteeId: string }>;
}) {
  const { consulteeId } = await params;
  return <SupportSurface profileId={consulteeId} />;
}
