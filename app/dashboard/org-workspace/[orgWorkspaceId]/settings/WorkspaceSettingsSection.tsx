"use client";

/**
 * The Default landing organization section (read by lib/dashboard/landing.ts).
 * Locale and currency stay hidden until something reads them.
 *
 * The IDOR check (`orgWorkspaceProfileId === orgWorkspaceId`) runs
 * server-side on every API call. Hydrates from WorkspaceSettingsPage's
 * prefetch.
 */

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

import { DefaultLandingOrgSection } from "./components/DefaultLandingOrgSection";
import { fetchSettings } from "./utils/api";

export function WorkspaceSettingsSection({
  orgWorkspaceId,
}: Readonly<{ orgWorkspaceId: string }>) {
  const settings = useQuery({
    queryKey: ["org-workspace-settings", orgWorkspaceId],
    queryFn: () => fetchSettings(orgWorkspaceId),
  });

  if (settings.isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading preferences…
        </CardContent>
      </Card>
    );
  }
  if (settings.isError || !settings.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-red-700">
            Couldn’t load preferences
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-zinc-600">
          <p>
            If the problem persists, contact support — the workspace profile row
            may be missing.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => settings.refetch()}
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }
  return (
    <DefaultLandingOrgSection
      orgWorkspaceId={orgWorkspaceId}
      current={settings.data.profile.defaultLandingOrganizationId}
      candidates={settings.data.candidateOrgs}
    />
  );
}
