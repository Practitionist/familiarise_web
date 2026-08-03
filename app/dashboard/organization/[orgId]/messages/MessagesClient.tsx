"use client";

import { Loader2 } from "lucide-react";

import { ChatLayout } from "@/components/chat/ChatLayout";
import { StreamChatScope } from "@/components/stream/StreamChatScope";
import { ChatUnavailable } from "@/components/chat/ChatUnavailable";
import { useStreamConnection } from "@/providers/StreamProvider";

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
  const { chatConnected, error, retryConnection } = useStreamConnection();

  if (error) {
    return <ChatUnavailable description={error} onRetry={retryConnection} />;
  }

  if (!chatConnected) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-6 w-6 animate-spin" />
        Connecting to chat…
      </div>
    );
  }

  return (
    <StreamChatScope>
      <ChatLayout />
    </StreamChatScope>
  );
}
