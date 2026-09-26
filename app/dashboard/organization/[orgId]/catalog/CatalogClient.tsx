"use client";

import Link from "next/link";

import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Library, Plus } from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { EmptyState } from "@/components/dashboard/DataCard";
import { Section } from "@/components/dashboard/Section";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { InvitationsPanel } from "@/components/collaborators/InvitationsPanel";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { CatalogPanel } from "./CatalogPanel";
import { MaterialsPanel, type OrgMaterialRow } from "./MaterialsPanel";
import type { CatalogRow, CatalogResponse, Kind } from "./types";

interface Expert {
  consultantProfileId: string;
  name: string;
}

export function CatalogClient({
  orgId,
  experts,
  materials,
  materialsTotal,
}: Readonly<{
  orgId: string;
  experts: Expert[];
  materials: OrgMaterialRow[];
  materialsTotal: number;
}>) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expertId, setExpertId] = useState<string>(
    experts.length === 1 ? experts[0].consultantProfileId : "",
  );

  const queryKey = useMemo(() => ["org-catalog", orgId], [orgId]);

  const { data, isLoading, error } = useQuery<CatalogResponse>({
    queryKey,
    queryFn: async () => {
      // One fetch drives both views; the client partitions on archivedAt so
      // restoring does not need a second round trip.
      const res = await fetch(
        `/api/organizations/${orgId}/catalog?includeArchived=true`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to load the catalog");
      }
      return res.json();
    },
  });

  const setArchived = useMutation({
    mutationFn: async ({
      kind,
      planId,
      restore,
    }: {
      kind: Kind;
      planId: string;
      restore: boolean;
    }) => {
      const res = await fetch(
        `/api/organizations/${orgId}/catalog${restore ? "?restore=true" : ""}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, planIds: [planId] }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? "Could not update");
      }
      return res.json();
    },
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey });
      toast({
        title: vars.restore ? "Back on sale" : "Withdrawn from the catalog",
        description: vars.restore
          ? undefined
          : "Existing bookings and their records are unaffected.",
      });
    },
    onError: (e: Error) =>
      toast({
        title: "Could not update",
        description: e.message,
        variant: "destructive",
      }),
  });

  // Stable per-kind callbacks so CatalogPanel's memoized columns are not
  // invalidated on every parent render — which would undo the point of the
  // split. `setArchived.mutate` is referentially stable across renders.
  const archiveWebinar = useCallback(
    (planId: string, restore: boolean) =>
      setArchived.mutate({ kind: "WEBINAR", planId, restore }),
    [setArchived],
  );
  const archiveClass = useCallback(
    (planId: string, restore: boolean) =>
      setArchived.mutate({ kind: "CLASS", planId, restore }),
    [setArchived],
  );

  // The fetch asks for everything; the split happens here so restoring a plan
  // does not need a second round trip.
  const live = (rows: CatalogRow[] | undefined) =>
    (rows ?? []).filter((r) => r.archivedAt === null);
  const archivedWebinars = (data?.webinars ?? []).filter(
    (r) => r.archivedAt !== null,
  );
  const archivedClasses = (data?.classes ?? []).filter(
    (r) => r.archivedAt !== null,
  );

  // No experts, nothing to publish — an org plan needs somebody to deliver it,
  // so say that plainly rather than opening a form that will 422.
  const blocked = experts.length === 0;

  const noExperts = (
    <EmptyState
      icon={Library}
      title="Invite an expert first"
      description="Catalog offerings are delivered by an organization expert. Invite one from Members, then come back to publish."
    />
  );
  const hasArchived = archivedWebinars.length + archivedClasses.length > 0;

  return (
    <>
      <DashboardHeader
        title="Catalog"
        description="Webinars and classes this organization owns and sells, their materials and their collaborators."
      />
      <DashboardContent>
        {!blocked && (
          <div className="flex flex-wrap items-end gap-3">
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
            {/* Prefetching Links (Button asChild) instead of onClick
                SPA-pushes. An anchor cannot be disabled, so the no-expert
                state keeps a plain disabled Button with identical styling. */}
            {expertId ? (
              <Button asChild>
                <Link
                  href={`/dashboard/organization/${orgId}/catalog/webinar/new?expertId=${expertId}`}
                >
                  <Plus className="mr-1.5 h-4 w-4" />
                  New webinar
                </Link>
              </Button>
            ) : (
              <Button disabled>
                <Plus className="mr-1.5 h-4 w-4" />
                New webinar
              </Button>
            )}
            {expertId ? (
              <Button asChild variant="outline">
                <Link
                  href={`/dashboard/organization/${orgId}/catalog/class/new?expertId=${expertId}`}
                >
                  <Plus className="mr-1.5 h-4 w-4" />
                  New class
                </Link>
              </Button>
            ) : (
              <Button variant="outline" disabled>
                <Plus className="mr-1.5 h-4 w-4" />
                New class
              </Button>
            )}
          </div>
        )}

        <UrlTabs
          tabs={[
            {
              value: "webinars",
              label: "Webinars",
              content: blocked ? (
                noExperts
              ) : (
                <CatalogPanel
                  kind="WEBINAR"
                  rows={live(data?.webinars)}
                  isLoading={isLoading}
                  error={error}
                  onToggleArchive={archiveWebinar}
                  isMutating={setArchived.isPending}
                />
              ),
            },
            {
              value: "classes",
              label: "Classes",
              content: blocked ? (
                noExperts
              ) : (
                <CatalogPanel
                  kind="CLASS"
                  rows={live(data?.classes)}
                  isLoading={isLoading}
                  error={error}
                  onToggleArchive={archiveClass}
                  isMutating={setArchived.isPending}
                />
              ),
            },
            {
              // Withdrawn plans answer "what did we stop selling"; hidden
              // until something has been withdrawn.
              value: "archived",
              label: "Archived",
              show: hasArchived,
              content: (
                <>
                  {archivedWebinars.length > 0 && (
                    <Section title="Webinars">
                      <CatalogPanel
                        kind="WEBINAR"
                        rows={archivedWebinars}
                        isLoading={isLoading}
                        error={error}
                        onToggleArchive={archiveWebinar}
                        isMutating={setArchived.isPending}
                      />
                    </Section>
                  )}
                  {archivedClasses.length > 0 && (
                    <Section title="Classes">
                      <CatalogPanel
                        kind="CLASS"
                        rows={archivedClasses}
                        isLoading={isLoading}
                        error={error}
                        onToggleArchive={archiveClass}
                        isMutating={setArchived.isPending}
                      />
                    </Section>
                  )}
                </>
              ),
            },
            {
              // #1527-4d — materials belong to plans.
              value: "materials",
              label: "Materials",
              content: (
                <MaterialsPanel items={materials} total={materialsTotal} />
              ),
            },
            {
              // #1527-4c — operators manage collaborators here; experts keep
              // the Plan collaborators page. Same component, org-scoped.
              value: "collaborators",
              label: "Collaborators",
              content: <InvitationsPanel orgScope={orgId} />,
            },
          ]}
        />
      </DashboardContent>
    </>
  );
}
