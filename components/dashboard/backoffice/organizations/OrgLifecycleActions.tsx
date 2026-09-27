"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

type OrgAction = "VERIFY" | "REJECT" | "SUSPEND" | "REACTIVATE" | "DEACTIVATE";

/** What the verify route allows from each status (its `allowedFrom`). */
const ALLOWED: Record<string, OrgAction[]> = {
  PENDING_VERIFICATION: ["VERIFY", "REJECT", "DEACTIVATE"],
  ACTIVE: ["SUSPEND", "DEACTIVATE"],
  SUSPENDED: ["REACTIVATE", "DEACTIVATE"],
  DEACTIVATED: [],
};

const COPY: Record<
  OrgAction,
  { label: string; title: string; description: string; destructive?: boolean }
> = {
  VERIFY: {
    label: "Verify",
    title: "Verify this organization?",
    description:
      "It becomes active: it can sign contracts, invite members and receive payouts.",
  },
  REJECT: {
    label: "Reject",
    title: "Send the verification back?",
    description:
      "It stays pending; the owner sees your reason and can fix and resubmit.",
    destructive: true,
  },
  SUSPEND: {
    label: "Suspend",
    title: "Suspend this organization?",
    description: "Members lose access until it is reactivated.",
    destructive: true,
  },
  REACTIVATE: {
    label: "Reactivate",
    title: "Reactivate this organization?",
    description: "Members get their access back.",
  },
  DEACTIVATE: {
    label: "Deactivate",
    title: "Deactivate this organization for good?",
    description: "Deactivation is terminal and cannot be undone from here.",
    destructive: true,
  },
};

/**
 * #1527 Q10 — the org lifecycle doors (`/api/admin/organizations/[id]/verify`)
 * behind ConfirmDialog: every action asks why, Reject sends the reason to the
 * owner, and Deactivate — terminal — is typed-confirmed with the org's slug.
 */
export function OrgLifecycleActions({
  org,
  size = "sm",
}: Readonly<{
  org: { id: string; name: string; slug: string; status: string };
  size?: "sm" | "default";
}>) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const router = useRouter();
  const actions = ALLOWED[org.status] ?? [];

  const run = async (action: OrgAction, reason?: string) => {
    const res = await fetch(`/api/admin/organizations/${org.id}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, reason }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(json.error ?? "That did not go through.");
    toast({ title: `${org.name}: ${COPY[action].label.toLowerCase()} done` });
    for (const key of [
      ["admin-organizations"],
      ["admin-organization", org.id],
      ["backoffice-nav-counts"],
    ]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
    // The org detail page is server-rendered; re-read it.
    router.refresh();
  };

  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => {
        const copy = COPY[action];
        return (
          <ConfirmDialog
            key={action}
            trigger={
              <Button size={size} variant="outline">
                {copy.label}
              </Button>
            }
            title={copy.title}
            description={`${org.name}. ${copy.description}`}
            confirmLabel={copy.label}
            tone={copy.destructive ? "destructive" : "default"}
            requireReason={{
              label:
                action === "REJECT"
                  ? "What the owner needs to fix"
                  : "Reason (kept in the org audit log)",
            }}
            requireTyped={action === "DEACTIVATE" ? org.slug : undefined}
            onConfirm={({ reason }) => run(action, reason)}
          />
        );
      })}
    </div>
  );
}
