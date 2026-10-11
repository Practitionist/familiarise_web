import { MessagesSquare } from "lucide-react";

import { EmptyState } from "@/components/dashboard/EmptyState";
import { SupportHealthAndComplianceOverview } from "@/components/dashboard/backoffice/support/SupportHealthAndComplianceOverview";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function SupportInboxPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  const { tree } = await params;
  await requireBackofficePage("tickets.manage", tree);
  return (
    <div>
      <SupportHealthAndComplianceOverview tree={tree} />
      <div className="rounded-lg border border-dashed border-border">
        <EmptyState
          icon={MessagesSquare}
          title="Pick a case"
          description="Choose a case from the list to read it and reply."
        />
      </div>
    </div>
  );
}
