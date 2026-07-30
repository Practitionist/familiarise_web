"use client";

import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Library, Plus, Trash2, Loader2 } from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { EmptyState } from "@/components/dashboard/DataCard";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { Button } from "@/components/ui/button";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { formatCurrencyAmount } from "@/utils/formatting";
import { EventPlannerForWebinar } from "@/components/planner/components/EventPlannerForWebinar";
import { EventPlannerForClass } from "@/components/planner/components/EventPlannerForClass";
import type { WebinarEvent, ClassEvent } from "@/types/planner-events";

type Kind = "WEBINAR" | "CLASS";

interface Expert {
  consultantProfileId: string;
  name: string;
}

/** Row shape as the API returns it — `price` is a paise string (BigInt). */
interface CatalogRow {
  id: string;
  title: string;
  price: string;
  visibility: "PUBLIC" | "ORG_ONLY" | "ORG_AND_PUBLIC";
  maxParticipants: number;
  consultantProfileId: string | null;
}

interface CatalogResponse {
  webinars: CatalogRow[];
  classes: CatalogRow[];
}

const VISIBILITY_LABEL: Record<CatalogRow["visibility"], string> = {
  PUBLIC: "Public",
  ORG_ONLY: "Members only",
  ORG_AND_PUBLIC: "Public + members",
};

export function CatalogClient({
  orgId,
  experts,
}: Readonly<{ orgId: string; experts: Expert[] }>) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [composing, setComposing] = useState<Kind | null>(null);
  const [expertId, setExpertId] = useState<string>(
    experts.length === 1 ? experts[0].consultantProfileId : "",
  );

  const queryKey = useMemo(() => ["org-catalog", orgId], [orgId]);

  const { data, isLoading, error } = useQuery<CatalogResponse>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/catalog`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to load the catalog");
      }
      return res.json();
    },
  });

  const createPlan = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await fetch(`/api/organizations/${orgId}/catalog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? "Could not save the plan");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
      setComposing(null);
      toast({ title: "Added to the catalog" });
    },
    onError: (e: Error) =>
      toast({
        title: "Could not save",
        description: e.message,
        variant: "destructive",
      }),
  });

  const removePlan = useMutation({
    mutationFn: async ({ kind, planId }: { kind: Kind; planId: string }) => {
      const res = await fetch(`/api/organizations/${orgId}/catalog`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, planIds: [planId] }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? "Could not remove");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
      toast({ title: "Removed from the catalog" });
    },
    onError: (e: Error) =>
      toast({
        title: "Could not remove",
        description: e.message,
        variant: "destructive",
      }),
  });

  // The shared planner forms hand back a full plan object; the catalog endpoint
  // wants the flat subset it owns. Mapping here rather than widening the API
  // keeps the endpoint's contract independent of the form's internals.
  const handleWebinarSave = useCallback(
    (event: Partial<WebinarEvent>) => {
      const plan = event.webinarPlan;
      if (!plan) return;
      createPlan.mutate({
        kind: "WEBINAR",
        title: plan.title,
        description: plan.description ?? "",
        pricePaise: plan.price,
        consultantProfileId: expertId,
        visibility: plan.visibility,
        maxParticipants: plan.maxParticipants,
        durationInHours: plan.durationInHours,
        language: plan.language ?? "English",
        level: plan.level ?? "Beginner",
        certificateProvided: plan.certificateProvided,
        recordingEnabled: plan.recordingEnabled,
      });
    },
    [createPlan, expertId],
  );

  const handleClassSave = useCallback(
    (event: Partial<ClassEvent>) => {
      const plan = event.classPlan;
      if (!plan) return;
      createPlan.mutate({
        kind: "CLASS",
        title: plan.title,
        description: plan.description ?? "",
        pricePaise: plan.price,
        consultantProfileId: expertId,
        visibility: plan.visibility,
        maxParticipants: plan.maxParticipants,
        durationInMonths: plan.durationInMonths,
        meetingsPerWeek: plan.meetingsPerWeek,
        sessionDurationInHours: plan.sessionDurationInHours,
        language: plan.language ?? "English",
        level: plan.level ?? "Beginner",
        certificateProvided: plan.certificateProvided,
        recordingEnabled: plan.recordingEnabled,
      });
    },
    [createPlan, expertId],
  );

  const columns = useCallback(
    (kind: Kind): ResponsiveColumn<CatalogRow>[] => [
      {
        key: "title",
        header: "Offering",
        primary: true,
        cell: (r) => <span className="font-medium">{r.title}</span>,
      },
      {
        key: "price",
        header: "Price",
        cell: (r) => formatCurrencyAmount(Number(r.price), "INR"),
      },
      {
        key: "visibility",
        header: "Visibility",
        cell: (r) => VISIBILITY_LABEL[r.visibility],
      },
      {
        key: "seats",
        header: "Seats",
        cell: (r) => r.maxParticipants,
      },
      {
        key: "actions",
        header: "",
        hideOnCard: true,
        cell: (r) => (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove ${r.title}`}
            disabled={removePlan.isPending}
            onClick={() => removePlan.mutate({ kind, planId: r.id })}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ),
      },
    ],
    [removePlan],
  );

  const renderList = (kind: Kind, rows: CatalogRow[]) => {
    if (isLoading) {
      return (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading the catalog…
        </div>
      );
    }
    if (error) {
      return (
        <EmptyState
          icon={Library}
          title="Couldn't load the catalog"
          description={error instanceof Error ? error.message : undefined}
        />
      );
    }
    if (rows.length === 0) {
      return (
        <EmptyState
          icon={Library}
          title={`No ${kind === "WEBINAR" ? "webinars" : "classes"} yet`}
          description="Offerings you publish here are owned by the organization and delivered by one of its experts."
        />
      );
    }
    return (
      <ResponsiveTable
        columns={columns(kind)}
        rows={rows}
        getRowId={(r) => r.id}
      />
    );
  };

  // No experts, nothing to publish — an org plan needs somebody to deliver it,
  // so say that plainly rather than opening a form that will 422.
  const blocked = experts.length === 0;

  return (
    <>
      <DashboardHeader
        title="Catalog"
        subtitle="Webinars and classes this organization owns and sells."
      />
      <DashboardContent>
        {blocked ? (
          <EmptyState
            icon={Library}
            title="Invite an expert first"
            description="Catalog offerings are delivered by an organization expert. Invite one from Members, then come back to publish."
          />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-end gap-3">
              <div className="min-w-56">
                <label
                  htmlFor="catalog-expert"
                  className="mb-1 block text-sm font-medium"
                >
                  Delivered by
                </label>
                <Select value={expertId} onValueChange={setExpertId}>
                  <SelectTrigger id="catalog-expert">
                    <SelectValue placeholder="Choose an expert" />
                  </SelectTrigger>
                  <SelectContent>
                    {experts.map((e) => (
                      <SelectItem
                        key={e.consultantProfileId}
                        value={e.consultantProfileId}
                      >
                        {e.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={() => setComposing("WEBINAR")}
                disabled={!expertId}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                New webinar
              </Button>
              <Button
                variant="outline"
                onClick={() => setComposing("CLASS")}
                disabled={!expertId}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                New class
              </Button>
            </div>

            <UrlTabs
              tabs={[
                {
                  value: "webinars",
                  label: "Webinars",
                  content: renderList("WEBINAR", data?.webinars ?? []),
                },
                {
                  value: "classes",
                  label: "Classes",
                  content: renderList("CLASS", data?.classes ?? []),
                },
              ]}
            />
          </>
        )}
      </DashboardContent>

      {/* The same forms the consultant planner uses. `organizationId` is what
          makes the resulting plan org-owned; `consultantId` names the deliverer,
          which on this surface is the picked expert rather than the viewer. */}
      {composing === "WEBINAR" && expertId && (
        <EventPlannerForWebinar
          isOpen
          onClose={() => setComposing(null)}
          onSave={handleWebinarSave}
          consultantId={expertId}
          organizationId={orgId}
          isSaving={createPlan.isPending}
        />
      )}
      {composing === "CLASS" && expertId && (
        <EventPlannerForClass
          isOpen
          onClose={() => setComposing(null)}
          onSave={handleClassSave}
          consultantId={expertId}
          organizationId={orgId}
          isSaving={createPlan.isPending}
        />
      )}
    </>
  );
}
