import { MessagesSquare } from "lucide-react";

import { EmptyState } from "@/components/dashboard/EmptyState";
import { requireBackofficePage } from "@/lib/auth-guard";

/** #1527 — the inbox with no case open; the layout renders the list. */
export default async function SupportInboxPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("tickets.manage", (await params).tree);
  return (
    <div className="rounded-lg border border-dashed border-border">
      <EmptyState
        icon={MessagesSquare}
        title="Pick a case"
        description="Choose a case from the list to read it and reply."
      />
    </div>
  );
}
