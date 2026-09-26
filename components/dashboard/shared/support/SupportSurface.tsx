"use client";

/**
 * The org-workspace Support page. It reuses the personal trees' SupportHub —
 * role-agnostic by construction; operator flows (org billing intents, org
 * attribution on escalation) activate server-side from memberships.
 *
 * #1527 — an operator has no sessions of their own, so it opens on Platform,
 * and the subtab lives in the URL like everywhere else.
 */

import { PageHeader } from "@/components/dashboard/PageScaffold";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";

import { SupportHub } from "./SupportHub";

export function SupportSurface({ profileId }: { profileId: string }) {
  return (
    <DashboardErrorBoundary>
      <PageHeader
        title="Support"
        description="Get help with the platform or a session, and track every request."
      />
      <SupportHub profileId={profileId} defaultView="platform" />
    </DashboardErrorBoundary>
  );
}
