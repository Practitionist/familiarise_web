"use client";

import { ChatSurface } from "@/components/chat/ChatSurface";

/**
 * Full-bleed chat surface: cancels PageScaffold padding and fills the
 * content column under the context bar (and above the mobile tab bar).
 *
 * Takes no props: the page above used to run a whole consultant-details query
 * to feed a `userId`/`userRole` pair this component immediately discarded.
 */
export function MessagesTab() {
  return (
    <div className="-m-4 h-dashboard-fill overflow-hidden border-border bg-card sm:-m-6 lg:-m-8">
      <ChatSurface />
    </div>
  );
}
