import { HelpAndSupportPage } from "@/components/dashboard/shared/support/HelpAndSupportPage";
import { HelpCenterPanel } from "@/app/support/_components/HelpCenterPanel";
import { ExpertFaqPanel } from "@/components/dashboard/shared/support/ExpertFaqPanel";

/**
 * Help & support (#1527 Q2) — Requests · Feedback · Help center. Experts get
 * the expert topics plus the consultant FAQ the help centre does not cover.
 */
export default async function SupportPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  return (
    <HelpAndSupportPage
      profileId={consultantId}
      basePath={`/dashboard/consultant/${consultantId}`}
      helpCenter={
        <div className="space-y-8">
          <HelpCenterPanel audience="expert" />
          <ExpertFaqPanel />
        </div>
      }
    />
  );
}
