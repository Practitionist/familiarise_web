"use client";

import { useEffect, useState, use } from "react";
import { fetchApprovals } from "../../utils";
import { type IApproval } from "../../types";
import { RequestsTab } from "./RequestsTab";

export default function RequestsPage({
  params,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
}>) {
  const resolvedParams = use(params);
  const consultantId = resolvedParams.consultantId;

  const [approvals, setApprovals] = useState<IApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        setIsLoading(true);
        setError(null);

        const approvalsData = await fetchApprovals(consultantId);
        setApprovals(approvalsData);
      } catch (err) {
        console.error("Error fetching approvals:", err);
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        setIsLoading(false);
      }
    }

    fetchData();
  }, [consultantId]);

  if (error) {
    return (
      <div className="bg-white p-4 rounded-lg shadow-md">
        <p className="text-red-600">{error}</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="bg-white p-4 rounded-lg shadow-md">
        <p>Loading...</p>
      </div>
    );
  }

  return <RequestsTab approvals={approvals} />;
}
