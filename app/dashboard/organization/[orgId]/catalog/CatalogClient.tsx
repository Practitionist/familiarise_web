"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Library, Plus } from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { EmptyState } from "@/components/dashboard/DataCard";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { expertVerificationLabel } from "@/lib/labels/org-labels";
import { isArchivedCatalogView } from "@/lib/dashboard/org-catalog-view";
import { CatalogPanel } from "./CatalogPanel";
import {
  MaterialsPanel,
  type OrgMaterialRow,
  type OrgPlanOption,
} from "./MaterialsPanel";
import type { CatalogResponse, CatalogRow, Kind } from "./types";

interface Expert {
  consultantProfileId: string;
  name: string;
  /** False while the expert waits for verification: learners cannot see their offerings yet. */
  isVerified: boolean;
}

export function CatalogClient({
  orgId,
  experts,
  materials,
  materialsTotal,
  orgPlans,
}: Readonly<{
  orgId: string;
  experts: Expert[];
  materials: OrgMaterialRow[];
  materialsTotal: number;
  orgPlans: OrgPlanOption[];
}>) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const pickable = experts.filter((e) => e.isVerified);
  const [expertId, setExpertId] = useState<string>(
    pickable.length === 1 ? pickable[0].consultantProfileId : "",
  );

  const queryKey = useMemo(() => ["org-catalog", orgId], [orgId]);

  const { data, isLoading, error } = useQuery<CatalogResponse>({
    queryKey,
    queryFn: async () => {
      // Archived rows ride along so the lists' Archived filter and a restore
      // need no second round trip.
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

  const expertNamesById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const e of experts) {
      map[e.consultantProfileId] = e.name;
    }
    return map;
  }, [experts]);

  // Read from the URL every render, so back/forward and links into or out of
  // `?status=archived` re-pick the default tab. Without a tab, the archived
  // view opens the first kind that has archived rows.
  const searchParams = useSearchParams();
  const showArchived = isArchivedCatalogView(searchParams?.get("status"));
  const hasArchived = (rows?: CatalogRow[]) =>
    rows?.some((r) => r.archivedAt !== null) ?? false;
  const defaultTab =
    showArchived && !hasArchived(data?.webinars) && hasArchived(data?.classes)
      ? "classes"
      : undefined;

  // No experts, nothing new to publish: an org plan needs somebody to deliver
  // it. Existing plans still list; only creation is gated.
  const blocked = experts.length === 0;

  const noExperts = (
    <EmptyState
      icon={Library}
      title="Invite an expert to publish new offerings"
      description="New catalog offerings are delivered by an organization expert. Invite one from Members, then come back to publish. Existing offerings stay listed here."
    />
  );

  return (
    <>
      <DashboardHeader
        title="Catalog"
        description="Webinars and classes this organization owns and sells, and their materials."
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
                      disabled={!e.isVerified}
                    >
                      {e.name}
                      {!e.isVerified && ` · ${expertVerificationLabel(false)}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {pickable.length === 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  No expert is verified yet; you can publish once one is.
                </p>
              )}
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
          defaultValue={defaultTab}
          tabs={[
            {
              value: "webinars",
              label: "Webinars",
              content: (
                <CatalogPanel
                  kind="WEBINAR"
                  rows={data?.webinars ?? []}
                  isLoading={isLoading}
                  error={error}
                  onToggleArchive={archiveWebinar}
                  isMutating={setArchived.isPending}
                  expertNamesById={expertNamesById}
                  creationBlocked={blocked ? noExperts : undefined}
                />
              ),
            },
            {
              value: "classes",
              label: "Classes",
              content: (
                <CatalogPanel
                  kind="CLASS"
                  rows={data?.classes ?? []}
                  isLoading={isLoading}
                  error={error}
                  onToggleArchive={archiveClass}
                  isMutating={setArchived.isPending}
                  expertNamesById={expertNamesById}
                  creationBlocked={blocked ? noExperts : undefined}
                />
              ),
            },
            {
              // Materials belong to plans.
              value: "materials",
              label: "Materials",
              content: (
                <MaterialsPanel
                  items={materials}
                  total={materialsTotal}
                  plans={orgPlans}
                />
              ),
            },
          ]}
        />
      </DashboardContent>
    </>
  );
}
