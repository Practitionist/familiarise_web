import { ReferralsPage } from "@/components/dashboard/shared/ReferralsPage";

/** Invite & earn — shared with the consultant dashboard; see the component. */
export default async function ConsulteeReferralsPage({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = await params;
  return (
    <ReferralsPage
      role="CONSULTEE"
      creditsHref={`/dashboard/consultee/${consulteeId}/payments?tab=credits`}
    />
  );
}
