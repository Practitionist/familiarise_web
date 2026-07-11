"use client";

/**
 * Collaborations panel — both perspectives of plan collaboration:
 *   - Host: my plans that have collaborators on them
 *   - Collaborator: invitations I've received (pending + accepted)
 *
 * Decomposed during the dashboard redesign: data fetching + the respond
 * mutation + section layout live here; the cards are in
 * PendingInvitationCard / ActiveCollaborationCard / HostedPlanCard, with
 * the schedule cluster in ScheduleSummaries and shapes in types.ts.
 * There are deliberately NO confirm dialogs — Accept/Decline fire the
 * mutation directly, as before.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Loader2, Inbox, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/dashboard/DataCard";
import type {
  CollaborationsData,
  CollaborationWithPlan,
  HostedPlanEntry,
} from "./types";
import { PendingInvitationCard } from "./PendingInvitationCard";
import { ActiveCollaborationCard } from "./ActiveCollaborationCard";
import { HostedPlanCard } from "./HostedPlanCard";

export function InvitationsPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery<CollaborationsData>({
    queryKey: ["my-collaborations"],
    queryFn: async () => {
      const res = await fetch("/api/collaborations");
      if (!res.ok) throw new Error("Failed to fetch collaborations");
      const json = await res.json();
      return json.data;
    },
    staleTime: 30_000,
  });

  const respondMutation = useMutation({
    mutationFn: async ({
      id,
      planType,
      response,
    }: {
      id: string;
      planType: "webinar" | "class";
      response: "ACCEPTED" | "DECLINED";
    }) => {
      const res = await fetch(`/api/collaborations/${id}/respond`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response, planType }),
      });
      if (!res.ok) throw new Error("Failed to respond");
      return res.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["my-collaborations"] });
      toast({
        title:
          variables.response === "ACCEPTED"
            ? "Invitation accepted"
            : "Invitation declined",
      });
    },
    onError: () => {
      toast({
        title: "Failed to respond to invitation",
        variant: "destructive",
      });
    },
  });

  // ── Collaborator perspective data ──
  const allCollaborations: CollaborationWithPlan[] = [
    ...(data?.webinarCollaborations.map((c) => ({
      ...c,
      planType: "webinar" as const,
      planTitle: c.webinarPlan?.title ?? "Webinar",
      planPrice: c.webinarPlan?.price ?? 0,
    })) ?? []),
    ...(data?.classCollaborations.map((c) => ({
      ...c,
      planType: "class" as const,
      planTitle: c.classPlan?.title ?? "Class",
      planPrice: c.classPlan?.price ?? 0,
    })) ?? []),
  ];

  const pending = allCollaborations.filter((c) => c.status === "PENDING");
  const accepted = allCollaborations.filter((c) => c.status === "ACCEPTED");

  // ── Host perspective data ──
  const hostedPlans: HostedPlanEntry[] = [
    ...(data?.hostedWebinarPlans?.map((p) => ({
      planType: "webinar" as const,
      title: p.title,
      price: p.price,
      collaborators: p.collaborators,
      webinarPlan: p,
    })) ?? []),
    ...(data?.hostedClassPlans?.map((p) => ({
      planType: "class" as const,
      title: p.title,
      price: p.price,
      collaborators: p.collaborators,
      classPlan: p,
    })) ?? []),
  ];

  const hasAnyData = allCollaborations.length > 0 || hostedPlans.length > 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load collaborations"
        description="Something went wrong while fetching your collaborations. Please try again."
        action={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  if (!hasAnyData) {
    return (
      <EmptyState
        icon={Inbox}
        title="No collaborations"
        description="When you invite collaborators to your plans or another consultant invites you, it will appear here."
      />
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-6">
        {/* ── Host section: My Plans with Collaborators ── */}
        {hostedPlans.length > 0 && (
          <div>
            <h2 className="text-base font-semibold text-zinc-700 mb-3">
              My Plans with Collaborators ({hostedPlans.length})
            </h2>
            <div className="space-y-2">
              {hostedPlans.map((plan) => (
                <HostedPlanCard
                  key={`${plan.planType}-${plan.webinarPlan?.id ?? plan.classPlan?.id}`}
                  plan={plan}
                  hostUser={data?.hostUser}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── Collaborator section: Pending Invitations ── */}
        <div>
          <h2 className="text-base font-semibold text-zinc-700 mb-3">
            Pending Invitations ({pending.length})
          </h2>
          {pending.length === 0 ? (
            <div className="text-center py-8 text-zinc-500 border border-dashed border-zinc-200 rounded-lg">
              <Inbox className="w-8 h-8 mx-auto mb-2 text-zinc-300" />
              <p className="text-sm font-medium">No pending invitations</p>
              <p className="text-xs mt-1 max-w-xs mx-auto">
                When another consultant invites you to co-host a webinar or
                class, the invitation will appear here.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {pending.map((collab) => (
                <PendingInvitationCard
                  key={collab.id}
                  collab={collab}
                  onRespond={(args) => respondMutation.mutate(args)}
                  isResponding={respondMutation.isPending}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Collaborator section: Active Collaborations ── */}
        {accepted.length > 0 && (
          <div>
            <h2 className="text-base font-semibold text-zinc-700 mb-3">
              Active Collaborations ({accepted.length})
            </h2>
            <div className="space-y-2">
              {accepted.map((collab) => (
                <ActiveCollaborationCard
                  key={collab.id}
                  collab={collab}
                  currentUser={data?.hostUser}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
