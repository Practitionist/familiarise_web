"use client";

import { useQuery } from "@tanstack/react-query";
import { SettingsIcon } from "lucide-react";
import { use, type ReactNode } from "react";
import type { TConsultantProfile } from "types/consultant";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { EmptyState } from "@/components/dashboard/DataCard";
import { DashboardContent } from "@/components/dashboard/PageScaffold";
import { SettingsSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { fetchConsultantData } from "../../utils/fetchHelpers";
import { consultantSettingsQueryKey } from "./settings";

/**
 * Loads the consultant profile a section edits and renders the four states
 * (skeleton, error, empty, data) once, so each section page is only its body.
 */
export function ConsultantSettingsLoader({
  consultantId,
  children,
}: {
  consultantId: string;
  children: (consultant: TConsultantProfile) => ReactNode;
}) {
  const {
    data: consultant,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: consultantSettingsQueryKey(consultantId),
    queryFn: () => fetchConsultantData(consultantId),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 2,
  });

  if (isLoading) return <SettingsSkeleton />;

  if (error) {
    return (
      <Card>
        <CardContent className="py-6">
          <EmptyState
            icon={SettingsIcon}
            title="Couldn't load your settings"
            description={
              error.message ||
              "Failed to load consultant settings. Please try again."
            }
            action={
              <Button
                type="button"
                variant="outline"
                onClick={() => void refetch()}
              >
                Retry
              </Button>
            }
          />
        </CardContent>
      </Card>
    );
  }

  if (!consultant) {
    return (
      <Card>
        <CardContent className="py-6">
          <EmptyState
            icon={SettingsIcon}
            title="No profile yet"
            description="We could not find a consultant profile for this account."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <DashboardErrorBoundary>{children(consultant)}</DashboardErrorBoundary>
  );
}

/**
 * A hub section page whose body edits the consultant profile: resolves the
 * route param, pads the content and runs the loader above.
 */
export function ConsultantSettingsSectionPage({
  params,
  children,
}: {
  params: Promise<{ consultantId: string }>;
  children: (consultant: TConsultantProfile) => ReactNode;
}) {
  const { consultantId } = use(params);
  return (
    <DashboardContent>
      <ConsultantSettingsLoader consultantId={consultantId}>
        {children}
      </ConsultantSettingsLoader>
    </DashboardContent>
  );
}
