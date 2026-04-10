"use client";

import { use } from "react";
import { useParams } from "next/navigation";
import { DisputeDetailPage } from "@/components/dashboard/shared/DisputeDetailPage";

export default function StaffDisputeDetailPage({
  params,
}: {
  params: Promise<{ disputeId: string }>;
}) {
  const { disputeId } = use(params);
  const routeParams = useParams();
  const staffId = routeParams.staffId as string;

  return (
    <DisputeDetailPage
      disputeId={disputeId}
      basePath={`/dashboard/staff/${staffId}`}
      apiEndpoint="/api/admin/disputes"
      allowEvidenceSubmission={false}
      queryKeyPrefix="staff"
    />
  );
}
