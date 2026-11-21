"use client";

import { useQuery } from "@tanstack/react-query";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { consultantFetchers } from "@/lib/dashboard-queries";
import { personalHomeTitle } from "@/lib/dashboard/operator-view";

/** An operator's title for an expert's Home: whose it is, not a welcome addressed to the operator. */
export function OperatorHomeHeader({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  // The layout reads the same key, so this is a cache hit.
  const { data } = useQuery({
    queryKey: ["consultant-data", consultantId],
    queryFn: () => consultantFetchers.details(consultantId),
  });
  const owner = data
    ? { userId: consultantId, name: data.user?.name ?? null, image: null }
    : null;
  return (
    <DashboardHeader
      title={personalHomeTitle(owner, false, "expert") ?? "This expert's home"}
      subtitle="What needs them, and what's next"
    />
  );
}
