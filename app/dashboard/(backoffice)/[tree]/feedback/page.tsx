import { FeedbackPage } from "@/components/dashboard/shared/FeedbackPage";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function BackofficeFeedbackPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("feedback.manage", (await params).tree);
  return (
    <FeedbackPage
      apiEndpoint="/api/staff/feedbacks"
      title="User Feedback"
      description="Manage and respond to user feedback across the platform"
    />
  );
}
