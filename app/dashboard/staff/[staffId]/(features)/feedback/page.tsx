"use client";

import { FeedbackPage } from "@/components/dashboard/shared/FeedbackPage";

export default function StaffFeedbackPage() {
  return (
    <FeedbackPage
      apiEndpoint="/api/staff/feedbacks"
      title="User Feedback"
      description="View and manage feedback submitted by users"
    />
  );
}
