"use client";

import { MessageSquareOff, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/DataCard";
import { PlatformSupportSheet } from "@/components/support/PlatformSupportSheet";
import {
  RETRYABLE_CONNECT_FAILURE,
  type ConnectFailure,
} from "@/lib/stream/connect-failure";

/**
 * Fallback for chat surfaces when the Stream client fails to connect —
 * previously both dashboards rendered ChatLayout unconditionally, leaving
 * a blank fixed-height box on init failure. Shared by the consultant
 * Chats tab, the consultee Messages tab and the org Messages page.
 *
 * Renders the classified failure, never the SDK's message: that string is a
 * JSON blob, and for a disabled account the honest offer is support, not a
 * Retry that cannot succeed.
 */
export function ChatUnavailable({
  failure,
  onRetry,
}: {
  failure?: ConnectFailure | null;
  onRetry?: () => void;
}) {
  const f = failure ?? RETRYABLE_CONNECT_FAILURE;
  const reload = () => window.location.reload();

  let action: React.ReactNode;
  if (f.action === "support") {
    action = (
      <PlatformSupportSheet
        trigger={<Button variant="outline">Contact support</Button>}
      />
    );
  } else if (f.action === "reload") {
    action = (
      <Button variant="outline" onClick={reload}>
        Reload
      </Button>
    );
  } else {
    action = (
      <Button variant="outline" onClick={onRetry ?? reload}>
        Retry
      </Button>
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={f.kind === "account-disabled" ? ShieldOff : MessageSquareOff}
        title={f.title}
        description={f.description}
        action={action}
      />
    </div>
  );
}
