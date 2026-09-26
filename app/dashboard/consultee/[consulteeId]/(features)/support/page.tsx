import { HelpAndSupportPage } from "@/components/dashboard/shared/support/HelpAndSupportPage";
import { HelpCenterPanel } from "@/app/support/_components/HelpCenterPanel";

/** Help & support (#1527 Q2) — Requests · Feedback · Help center (learner topics). */
export default async function SupportPage({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = await params;
  return (
    <HelpAndSupportPage
      profileId={consulteeId}
      basePath={`/dashboard/consultee/${consulteeId}`}
      helpCenter={<HelpCenterPanel audience="learner" />}
    />
  );
}
