"use client";

import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { Button } from "@/components/ui/button";

interface LeaveOrgButtonProps {
  orgId: string;
  orgName: string;
  orgSlug: string;
}

export function LeaveOrgButton({
  orgId,
  orgName,
  orgSlug,
}: Readonly<LeaveOrgButtonProps>) {
  const router = useRouter();

  return (
    <ConfirmDialog
      trigger={
        <Button
          variant="outline"
          size="sm"
          className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
        >
          Leave organization
        </Button>
      }
      title={`Leave ${orgName}?`}
      description="Your active sponsored program seats will be released immediately, and you will lose access to this organization's internal catalog. Existing booking history and receipts remain in your personal account."
      confirmLabel="Leave organization"
      tone="destructive"
      requireTyped={orgSlug || orgName}
      onConfirm={async () => {
        const res = await fetch(`/api/organizations/${orgId}/members/leave`, {
          method: "POST",
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            (body as { error?: string }).error ??
              "Failed to leave organization",
          );
        }
        router.push("/dashboard");
        router.refresh();
      }}
    />
  );
}
