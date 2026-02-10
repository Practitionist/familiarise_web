"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Check, X, Loader2, Inbox } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatCurrencyAmount } from "@/lib/utils";

interface Collaboration {
  id: string;
  role: string;
  revenueSharePercentage: number;
  status: "PENDING" | "ACCEPTED";
  createdAt: string;
  webinarPlan?: { id: string; title: string; price: number };
  classPlan?: { id: string; title: string; price: number };
  invitedBy: {
    user: { name: string | null };
  };
}

interface CollaborationsData {
  webinarCollaborations: Collaboration[];
  classCollaborations: Collaboration[];
}

export function InvitationsPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<CollaborationsData>({
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

  const allCollaborations = [
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (allCollaborations.length === 0) {
    return (
      <div className="text-center py-12 text-zinc-500">
        <Inbox className="w-10 h-10 mx-auto mb-3 text-zinc-300" />
        <p className="font-medium">No collaborations</p>
        <p className="text-sm mt-1">
          When another consultant invites you to collaborate, it will appear
          here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Pending invitations */}
      {pending.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-zinc-700 mb-3">
            Pending Invitations ({pending.length})
          </h3>
          <div className="space-y-3">
            {pending.map((collab) => (
              <div
                key={collab.id}
                className="p-4 bg-amber-50 border border-amber-200 rounded-lg"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-medium text-zinc-800">
                      {collab.planTitle}
                    </p>
                    <p className="text-sm text-zinc-600 mt-0.5">
                      Invited by{" "}
                      <span className="font-medium">
                        {collab.invitedBy.user.name ?? "Unknown"}
                      </span>
                    </p>
                    <div className="flex items-center gap-2 mt-2">
                      <Badge variant="secondary" className="text-xs">
                        {collab.planType === "webinar" ? "Webinar" : "Class"}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {collab.role.replace(/_/g, " ")}
                      </Badge>
                      <span className="text-xs text-zinc-500">
                        {collab.revenueSharePercentage}% revenue share
                      </span>
                      {collab.planPrice > 0 && (
                        <span className="text-xs text-zinc-500">
                          &middot; Plan price{" "}
                          {formatCurrencyAmount(collab.planPrice, "INR")}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 ml-4">
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() =>
                        respondMutation.mutate({
                          id: collab.id,
                          planType: collab.planType,
                          response: "ACCEPTED",
                        })
                      }
                      disabled={respondMutation.isPending}
                    >
                      <Check className="w-3.5 h-3.5 mr-1" />
                      Accept
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        respondMutation.mutate({
                          id: collab.id,
                          planType: collab.planType,
                          response: "DECLINED",
                        })
                      }
                      disabled={respondMutation.isPending}
                    >
                      <X className="w-3.5 h-3.5 mr-1" />
                      Decline
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Accepted collaborations */}
      {accepted.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-zinc-700 mb-3">
            Active Collaborations ({accepted.length})
          </h3>
          <div className="space-y-2">
            {accepted.map((collab) => (
              <div
                key={collab.id}
                className="flex items-center justify-between p-3 bg-white border border-zinc-200 rounded-lg"
              >
                <div>
                  <p className="text-sm font-medium text-zinc-800">
                    {collab.planTitle}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {collab.role.replace(/_/g, " ")} &middot;{" "}
                    {collab.revenueSharePercentage}% share &middot; by{" "}
                    {collab.invitedBy.user.name ?? "Unknown"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">
                    {collab.planType === "webinar" ? "Webinar" : "Class"}
                  </Badge>
                  <Badge
                    variant="default"
                    className="bg-emerald-50 text-emerald-700 border-emerald-200"
                  >
                    Active
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
