"use client";

import { ChatSurface } from "@/components/chat/ChatSurface";

/**
 * Org-scoped chat.
 *
 * Nothing here filters by organization, and that is the point: `useOrgScope`
 * inside `ChatSidebar` is ROUTE-PINNED under `/dashboard/organization/[orgId]/`,
 * so simply living at this path scopes the channel query to
 * `organization_id: { $eq: orgId }`. A member of several orgs gets one of these
 * per org, each showing only that org's threads, with no picker to set and
 * nothing to get wrong.
 *
 * What the viewer sees is still only their own conversations — Stream returns
 * channels they are a member of. This is a participant surface that happens to
 * live in the org tree, not an operator one. Operators cannot read it: there is
 * no org-wide chat query behind this page, and ADR 20 keeps session content with
 * the participants.
 */
export function MessagesClient() {
  return <ChatSurface />;
}
