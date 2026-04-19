"use client";

import { use, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Search } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";

import { useOrgRole } from "../useOrgRole";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCurrencyAmount } from "@/utils/formatting";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CatalogItem {
  id: string;
  planType: "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" | "CLASS";
  title: string;
  price: number;
  priceCurrency: string;
  consultant: { name: string | null; image: string | null } | null;
}

interface SearchResult extends CatalogItem {
  consultant: { name: string | null; image: string | null };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function fetchCatalog(
  orgId: string,
): Promise<{ catalog: CatalogItem[] }> {
  const res = await fetch(`/api/organizations/${orgId}/catalog`);
  if (!res.ok) throw new Error("Failed to load catalog");
  return res.json();
}

async function searchPlans(
  orgId: string,
  search: string,
  planType: string | null,
): Promise<{ results: SearchResult[] }> {
  const params = new URLSearchParams({ limit: "15" });
  if (search) params.set("search", search);
  if (planType && planType !== "ALL") params.set("planType", planType);
  const res = await fetch(
    `/api/organizations/${orgId}/catalog/search?${params}`,
  );
  if (!res.ok) return { results: [] };
  return res.json();
}

async function linkPlan(orgId: string, planId: string, planType: string) {
  const res = await fetch(`/api/organizations/${orgId}/catalog`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId, planType }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to add plan");
  }
}

async function unlinkPlan(orgId: string, planId: string, planType: string) {
  const res = await fetch(`/api/organizations/${orgId}/catalog`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId, planType }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to remove plan");
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const PLAN_TYPE_TABS = ["ALL", "CONSULTATION", "SUBSCRIPTION", "WEBINAR", "CLASS"];

export default function OrgPlansPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { isAtLeast } = useOrgRole(orgId);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["org-catalog", orgId],
    queryFn: () => fetchCatalog(orgId),
  });

  // Browse modal state
  const [showBrowse, setShowBrowse] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchType, setSearchType] = useState("ALL");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const debouncedSetSearch = useDebouncedCallback(
    (val: string) => setDebouncedSearch(val),
    300,
  );

  const searchResults = useQuery({
    queryKey: ["org-catalog-search", orgId, debouncedSearch, searchType],
    queryFn: () => searchPlans(orgId, debouncedSearch, searchType),
    enabled: showBrowse,
  });

  const catalogIds = new Set(data?.catalog.map((c) => c.id) ?? []);

  const addMutation = useMutation({
    mutationFn: ({ planId, planType }: { planId: string; planType: string }) =>
      linkPlan(orgId, planId, planType),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["org-catalog", orgId] }),
  });

  const removeMutation = useMutation({
    mutationFn: ({ planId, planType }: { planId: string; planType: string }) =>
      unlinkPlan(orgId, planId, planType),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["org-catalog", orgId] }),
  });

  return (
    <>
      <DashboardHeader
        title="Curated Plans"
        subtitle="Plans recommended for your learners"
        actions={
          isAtLeast("MAINTAINER") && (
            <Button size="sm" onClick={() => setShowBrowse(true)}>
              <Plus className="h-4 w-4 mr-1" /> Browse & add plans
            </Button>
          )
        }
      />
      <DashboardContent>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {isLoading
                ? "Loading…"
                : `${data?.catalog.length ?? 0} plans in catalog`}
            </CardTitle>
            <CardDescription>
              Consultant plans linked to your organization. Learners can book
              these through the explore page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : data && data.catalog.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Plan</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Consultant</TableHead>
                    <TableHead>Price</TableHead>
                    {isAtLeast("MAINTAINER") && (
                      <TableHead className="w-12"></TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.catalog.map((item) => (
                    <TableRow key={`${item.planType}-${item.id}`}>
                      <TableCell className="font-medium">
                        {item.title}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{item.planType}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Avatar className="h-6 w-6">
                            <AvatarImage src={item.consultant?.image ?? undefined} />
                            <AvatarFallback className="text-xs">
                              {(item.consultant?.name ?? "?").charAt(0)}
                            </AvatarFallback>
                          </Avatar>
                          <span className="text-sm text-zinc-700">
                            {item.consultant?.name ?? "—"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {formatCurrencyAmount(item.price, item.priceCurrency)}
                      </TableCell>
                      {isAtLeast("MAINTAINER") && (
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Remove from catalog"
                            onClick={() =>
                              removeMutation.mutate({
                                planId: item.id,
                                planType: item.planType,
                              })
                            }
                            disabled={removeMutation.isPending}
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="text-center py-8">
                <p className="text-sm text-zinc-500">
                  No plans curated yet.
                  {isAtLeast("MAINTAINER") &&
                    " Click 'Browse & add plans' to get started."}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </DashboardContent>

      {/* Browse & add modal */}
      <Dialog open={showBrowse} onOpenChange={setShowBrowse}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Browse consultant plans</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-400" />
              <Input
                placeholder="Search by plan name…"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  debouncedSetSearch(e.target.value);
                }}
                className="pl-9"
              />
            </div>

            <Tabs value={searchType} onValueChange={setSearchType}>
              <TabsList className="w-full">
                {PLAN_TYPE_TABS.map((t) => (
                  <TabsTrigger key={t} value={t} className="text-xs">
                    {t === "ALL" ? "All" : t.charAt(0) + t.slice(1).toLowerCase()}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="space-y-2">
              {searchResults.isLoading ? (
                <p className="text-sm text-zinc-500 text-center py-4">
                  Searching…
                </p>
              ) : searchResults.data &&
                searchResults.data.results.length > 0 ? (
                searchResults.data.results.map((result) => {
                  const isAdded = catalogIds.has(result.id);
                  return (
                    <div
                      key={`${result.planType}-${result.id}`}
                      className="flex items-center gap-3 p-3 rounded-lg border border-zinc-200 hover:border-zinc-300 transition-colors"
                    >
                      <Avatar className="h-8 w-8 shrink-0">
                        <AvatarImage src={result.consultant.image ?? undefined} />
                        <AvatarFallback className="text-xs">
                          {(result.consultant.name ?? "?").charAt(0)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-zinc-900 truncate">
                          {result.title}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-zinc-500">
                            {result.consultant.name}
                          </span>
                          <Badge
                            variant="outline"
                            className="text-[10px] h-4 px-1"
                          >
                            {result.planType}
                          </Badge>
                          <span className="text-xs text-zinc-500">
                            {formatCurrencyAmount(
                              result.price,
                              result.priceCurrency,
                            )}
                          </span>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant={isAdded ? "outline" : "default"}
                        disabled={isAdded || addMutation.isPending}
                        onClick={() =>
                          addMutation.mutate({
                            planId: result.id,
                            planType: result.planType,
                          })
                        }
                      >
                        {isAdded ? "Added" : "+ Add"}
                      </Button>
                    </div>
                  );
                })
              ) : (
                <p className="text-sm text-zinc-500 text-center py-4">
                  {searchQuery
                    ? "No plans found matching your search."
                    : "Search for consultant plans to add to your catalog."}
                </p>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
