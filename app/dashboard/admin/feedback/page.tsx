"use client";

import { FeedbackPage } from "@/components/dashboard/shared/FeedbackPage";

export default function AdminFeedbackPage() {
  return (
    <FeedbackPage
      apiEndpoint="/api/staff/feedbacks"
      title="User Feedback"
      description="Manage and respond to user feedback across the platform"
    />
  );
}
