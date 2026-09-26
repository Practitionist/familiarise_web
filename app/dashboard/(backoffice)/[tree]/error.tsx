"use client";

import { useParams } from "next/navigation";
import { DashboardRouteError } from "@/components/dashboard/DashboardRouteError";

export default function BackofficeDashboardError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  const tree = useParams<{ tree: string }>()?.tree ?? "admin";

  return (
    <DashboardRouteError
      error={error}
      reset={reset}
      scope={`dashboard/${tree}`}
      event="backoffice_dashboard_error"
      entityKey="area"
      entityId={tree}
      title="Something went wrong in the back office"
      devFallbackMessage="An unexpected error occurred while loading the back office."
      escape={{ href: "/dashboard", label: "Back to dashboard" }}
    />
  );
}
