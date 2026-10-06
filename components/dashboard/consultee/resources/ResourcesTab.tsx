"use client";

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowUpDown, FolderOpen, Search } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import {
  EventResourceCard,
  type EventResource,
  type ResourceArtifact,
} from "./EventResourceCard";

interface ResourcesData {
  consultations: EventResource[];
  subscriptions: EventResource[];
  webinars: EventResource[];
  classes: EventResource[];
  trials?: EventResource[];
}

interface ResourcesTabProps {
  data: ResourcesData | undefined;
  /**
   * Which artifact this view is for. Documents and Recordings are separate
   * destinations now; the event-type tabs stay as GROUPING, because "which
   * session was this from" is the question people actually ask of a file.
   */
  artifact?: ResourceArtifact;
  title?: string;
  subtitle?: string;
}

const EVENT_TYPES = [
  { key: "consultations", label: "Consultations" },
  { key: "subscriptions", label: "Subscriptions" },
  { key: "webinars", label: "Webinars" },
  { key: "classes", label: "Classes" },
  { key: "trials", label: "Trials" },
] as const;

export type OfferingFilterOption =
  "all" | "consultation" | "subscription" | "webinar" | "class";

const OFFERING_FILTER_OPTIONS: {
  value: OfferingFilterOption;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "consultation", label: "Consultation" },
  { value: "subscription", label: "Subscription" },
  { value: "webinar", label: "Webinar" },
  { value: "class", label: "Class" },
];

/**
 * `with_recordings` / `with_materials` only make sense on the combined view —
 * on the Documents page every event shown already has materials. The pages pass
 * an `artifact` and the control hides the redundant options itself.
 */
type FilterOption = "all" | "with_recordings" | "with_materials" | "completed";

function matchesResourceQuery(event: EventResource, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (event.planTitle.toLowerCase().includes(q)) return true;
  if ((event.consultantName ?? "").toLowerCase().includes(q)) return true;
  if (event.recordings.some((r) => r.title.toLowerCase().includes(q))) {
    return true;
  }
  if (
    event.materials.some(
      (m) =>
        (m.originalName || m.fileName).toLowerCase().includes(q) ||
        (m.description ?? "").toLowerCase().includes(q),
    )
  ) {
    return true;
  }
  return false;
}

function filterEvents(
  events: EventResource[],
  filter: FilterOption,
  searchQuery = "",
): EventResource[] {
  return events.filter((e) => {
    if (!matchesResourceQuery(e, searchQuery)) return false;
    if (filter === "all") return true;
    if (filter === "with_recordings") return e.recordings.length > 0;
    if (filter === "with_materials") return e.materials.length > 0;
    return e.status === "COMPLETED";
  });
}

function sortEvents(
  events: EventResource[],
  dir: "desc" | "asc",
): EventResource[] {
  return [...events].sort((a, b) => {
    const diff = new Date(a.date).getTime() - new Date(b.date).getTime();
    return dir === "desc" ? -diff : diff;
  });
}

function isFilterOption(value: string): value is FilterOption {
  return (
    value === "all" ||
    value === "with_recordings" ||
    value === "with_materials" ||
    value === "completed"
  );
}

export function ResourcesTab({
  data,
  artifact = "both",
  title,
  subtitle,
}: ResourcesTabProps) {
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [resourceFilter, setResourceFilter] = useState<FilterOption>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [offeringFilter, setOfferingFilter] =
    useState<OfferingFilterOption>("all");

  /**
   * Events that actually carry the artifact this page is for.
   *
   * Gating the card's CONTENTS was not enough: totals, tab labels, the default
   * tab and the empty state all counted every event, so Documents listed
   * recording-only sessions as empty cards and claimed a count that did not
   * match what was on screen. The artifact has to narrow the set first, and
   * everything downstream reads the narrowed one.
   */
  const artifactData = useMemo(() => {
    if (!data) return null;
    const keep = (events: EventResource[]) => {
      if (artifact === "both") return events;
      return events.filter((e) =>
        artifact === "materials"
          ? e.materials.length > 0
          : e.recordings.length > 0,
      );
    };
    return {
      consultations: keep(data.consultations),
      subscriptions: keep(data.subscriptions),
      webinars: keep(data.webinars),
      classes: keep(data.classes),
      trials: keep(data.trials ?? []),
    };
  }, [data, artifact]);

  const filteredData = useMemo(() => {
    if (!artifactData) return null;
    const data = artifactData;
    const keepOffering = (
      target: OfferingFilterOption,
      events: EventResource[],
    ) => (offeringFilter === "all" || offeringFilter === target ? events : []);
    return {
      consultations: sortEvents(
        filterEvents(
          keepOffering("consultation", data.consultations),
          resourceFilter,
          searchQuery,
        ),
        sortDir,
      ),
      subscriptions: sortEvents(
        filterEvents(
          keepOffering("subscription", data.subscriptions),
          resourceFilter,
          searchQuery,
        ),
        sortDir,
      ),
      webinars: sortEvents(
        filterEvents(
          keepOffering("webinar", data.webinars),
          resourceFilter,
          searchQuery,
        ),
        sortDir,
      ),
      classes: sortEvents(
        filterEvents(
          keepOffering("class", data.classes),
          resourceFilter,
          searchQuery,
        ),
        sortDir,
      ),
      trials: sortEvents(
        filterEvents(
          offeringFilter === "all" ? (data.trials ?? []) : [],
          resourceFilter,
          searchQuery,
        ),
        sortDir,
      ),
    };
  }, [artifactData, resourceFilter, searchQuery, offeringFilter, sortDir]);

  if (!data || !artifactData || !filteredData) return null;

  const totalResources =
    artifactData.consultations.length +
    artifactData.subscriptions.length +
    artifactData.webinars.length +
    artifactData.classes.length +
    artifactData.trials.length;

  if (totalResources === 0) {
    return (
      <>
        <PageHeader
          title={title ?? "Resources"}
          description={
            subtitle ?? "Materials and recordings from your enrolled events"
          }
        />
        <EmptyState
          variant="page"
          icon={FolderOpen}
          title={emptyTitle(artifact)}
          description={emptyDescription(artifact)}
        />
      </>
    );
  }

  const artifactNoun =
    artifact === "materials"
      ? "documents"
      : artifact === "recordings"
        ? "recordings"
        : "resources";

  const isFiltered =
    resourceFilter !== "all" ||
    searchQuery.trim().length > 0 ||
    offeringFilter !== "all";

  return (
    <div>
      <PageHeader
        title={title ?? "Resources"}
        description={
          subtitle ?? "Materials and recordings from your enrolled events"
        }
      />

      {/* Search + Offering Type + Filter + Sort controls */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-64">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`Search ${artifactNoun}…`}
            aria-label={`Search ${artifactNoun}`}
            className="pl-8"
          />
        </div>
        <div
          role="group"
          aria-label="Filter by offering type"
          className="flex flex-wrap items-center gap-1"
        >
          {OFFERING_FILTER_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              type="button"
              size="sm"
              variant={offeringFilter === opt.value ? "default" : "outline"}
              onClick={() => setOfferingFilter(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
        <Select
          value={resourceFilter}
          onValueChange={(v) => {
            if (isFilterOption(v)) setResourceFilter(v);
          }}
        >
          <SelectTrigger
            className="w-full sm:w-[180px]"
            aria-label={`Filter ${artifactNoun}`}
          >
            <SelectValue placeholder="Filter resources" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All {artifactNoun}</SelectItem>
            {/* Redundant on an artifact-specific page: every event shown on
                Documents already has materials, so "With materials" would
                filter nothing and "With recordings" would contradict the
                page. */}
            {artifact === "both" && (
              <>
                <SelectItem value="with_recordings">With recordings</SelectItem>
                <SelectItem value="with_materials">With materials</SelectItem>
              </>
            )}
            <SelectItem value="completed">Completed only</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
        >
          <ArrowUpDown className="h-4 w-4 mr-2" />
          {sortDir === "desc" ? "Newest first" : "Oldest first"}
        </Button>
      </div>

      <UrlTabs
        tabs={EVENT_TYPES.map(({ key, label }) => {
          const total = (artifactData[key as keyof ResourcesData] ?? []).length;
          const items = filteredData[key as keyof ResourcesData] ?? [];
          return {
            value: key,
            label: isFiltered
              ? `${label} · ${items.length}/${total}`
              : `${label} · ${total}`,
            show: total > 0,
            content: (
              <div className="space-y-4">
                {items.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No {artifactNoun} match the selected filter.
                  </p>
                ) : (
                  items.map((event) => (
                    <EventResourceCard
                      key={event.id}
                      event={event}
                      artifact={artifact}
                    />
                  ))
                )}
              </div>
            ),
          };
        })}
      />
    </div>
  );
}

function emptyTitle(artifact: ResourceArtifact): string {
  if (artifact === "materials") return "No documents yet";
  if (artifact === "recordings") return "No recordings yet";
  return "No resources yet";
}

function emptyDescription(artifact: ResourceArtifact): string {
  if (artifact === "recordings")
    return "Recordings appear here once a session you attended has been recorded and processed.";
  if (artifact === "materials")
    return "Handouts and materials shared for your sessions will appear here.";
  return "Resources from your enrolled consultations, subscriptions, webinars, and classes will appear here.";
}
