import { FeedbackPage } from "@/components/dashboard/shared/FeedbackPage";
import { SupportArticleFeedbackTable } from "@/components/dashboard/backoffice/support/SupportArticleFeedbackTable";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function BackofficeFeedbackPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("feedback.manage", (await params).tree);
  return (
    <div className="space-y-6">
      <FeedbackPage
        apiEndpoint="/api/staff/feedbacks"
        title="User Feedback"
        description="Manage and respond to user feedback across the platform"
      />
      {/* The other half of "feedback": what readers said about the Help
          Center itself, so a failing article is visible next to the reports
          it is generating. */}
      <SupportArticleFeedbackTable />
    </div>
  );
}
