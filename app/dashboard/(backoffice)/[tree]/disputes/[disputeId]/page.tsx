"use client";

import { use } from "react";
import { DisputeDetailPage } from "@/components/dashboard/shared/DisputeDetailPage";

export default function AdminDisputeDetailPage({
  params,
}: {
  params: Promise<{ disputeId: string }>;
}) {
  const { disputeId } = use(params);
  return (
    <DisputeDetailPage
      disputeId={disputeId}
      basePath="/dashboard/admin"
      apiEndpoint="/api/admin/disputes"
      allowEvidenceSubmission={true}
      queryKeyPrefix="admin"
    />
  );
}
