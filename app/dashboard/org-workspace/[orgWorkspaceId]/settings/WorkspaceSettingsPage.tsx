import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";

import { requireAuth } from "@/lib/auth-guard";
import { getWorkspaceSettings } from "@/lib/data/org-workspace";
import type { WorkspaceSettingsKey } from "@/lib/dashboard/nav/workspace";

import { WorkspaceSettingsSection } from "./WorkspaceSettingsSection";

/**
 * Server half of a workspace settings section: SSR-prefetches the settings
 * payload under ["org-workspace-settings", orgWorkspaceId] so the client's
 * useQuery hydrates from it. The layout's IDOR guard already ran.
 */
export async function WorkspaceSettingsPage({
  orgWorkspaceId,
  section,
}: Readonly<{ orgWorkspaceId: string; section: WorkspaceSettingsKey }>) {
  const session = await requireAuth();
  const queryClient = new QueryClient();
  // Key MUST match WorkspaceSettingsSection's useQuery or hydration won't apply.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["org-workspace-settings", orgWorkspaceId],
      queryFn: () => getWorkspaceSettings(session.user.id, orgWorkspaceId),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <WorkspaceSettingsSection
        orgWorkspaceId={orgWorkspaceId}
        section={section}
      />
    </HydrationBoundary>
  );
}
