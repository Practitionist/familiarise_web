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
  sortDir?: "desc" | "asc";
}

const EVENT_TYPES = [
  { key: "consultations", label: "Consultations" },
  { key: "subscriptions", label: "Subscriptions" },
  { key: "webinars", label: "Webinars" },
  { key: "classes", label: "Classes" },
  { key: "trials", label: "Trials" },
] as const;

/**
 * `with_recordings` / `with_materials` only make sense on the combined view —
 * on the Documents page every event shown already has materials. The pages pass
 * an `artifact` and the control hides the redundant options itself.
 */
type FilterOption = "all" | "with_recordings" | "with_materials" | "completed";

function matchesResourceQuery(
  event: EventResource,
  query: string,
  artifact: ResourceArtifact = "both",
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (event.planTitle.toLowerCase().includes(q)) return true;
  if ((event.contextTitle ?? "").toLowerCase().includes(q)) return true;
  if ((event.consultantName ?? "").toLowerCase().includes(q)) return true;
  if (
    artifact !== "materials" &&
    event.recordings.some((r) => r.title.toLowerCase().includes(q))
  ) {
    return true;
  }
  if (
    artifact !== "recordings" &&
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
  artifact: ResourceArtifact = "both",
): EventResource[] {
  return events.filter((e) => {
    if (!matchesResourceQuery(e, searchQuery, artifact)) return false;
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

function resolveArtifactNoun(artifact: ResourceArtifact): string {
  if (artifact === "materials") return "documents";
  if (artifact === "recordings") return "recordings";
  return "resources";
}

export function ResourcesTab({
  data,
  artifact = "both",
  title,
  subtitle,
  sortDir: externalSortDir,
}: ResourcesTabProps) {
  const [internalSortDir, setInternalSortDir] = useState<"desc" | "asc">(
    "desc",
  );
  const sortDir = externalSortDir ?? internalSortDir;
  const [resourceFilter, setResourceFilter] = useState<FilterOption>("all");
  const [searchQuery, setSearchQuery] = useState("");

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
    return {
      consultations: sortEvents(
        filterEvents(
          artifactData.consultations,
          resourceFilter,
          searchQuery,
          artifact,
        ),
        sortDir,
      ),
      subscriptions: sortEvents(
        filterEvents(
          artifactData.subscriptions,
          resourceFilter,
          searchQuery,
          artifact,
        ),
        sortDir,
      ),
      webinars: sortEvents(
        filterEvents(
          artifactData.webinars,
          resourceFilter,
          searchQuery,
          artifact,
        ),
        sortDir,
      ),
      classes: sortEvents(
        filterEvents(
          artifactData.classes,
          resourceFilter,
          searchQuery,
          artifact,
        ),
        sortDir,
      ),
      trials: sortEvents(
        filterEvents(
          artifactData.trials ?? [],
          resourceFilter,
          searchQuery,
          artifact,
        ),
        sortDir,
      ),
    };
  }, [artifactData, resourceFilter, searchQuery, sortDir, artifact]);

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
        {title && (
          <PageHeader
            title={title}
            description={
              subtitle ?? "Materials and recordings from your enrolled events"
            }
          />
        )}
        <EmptyState
          variant="page"
          icon={FolderOpen}
          title={emptyTitle(artifact)}
          description={emptyDescription(artifact)}
        />
      </>
    );
  }

  if (artifact === "recordings") {
    const mergedRecordings = sortEvents(
      [
        ...filteredData.consultations,
        ...filteredData.subscriptions,
        ...filteredData.webinars,
        ...filteredData.classes,
        ...filteredData.trials,
      ],
      sortDir,
    );

    return (
      <div className="space-y-4">
        {mergedRecordings.map((event) => (
          <EventResourceCard key={event.id} event={event} artifact={artifact} />
        ))}
      </div>
    );
  }

  const artifactNoun = resolveArtifactNoun(artifact);

  const isFiltered = resourceFilter !== "all" || searchQuery.trim().length > 0;

  return (
    <div>
      {title && (
        <PageHeader
          title={title}
          description={
            subtitle ?? "Materials and recordings from your enrolled events"
          }
        />
      )}

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
          onClick={() =>
            setInternalSortDir((d) => (d === "desc" ? "asc" : "desc"))
          }
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
