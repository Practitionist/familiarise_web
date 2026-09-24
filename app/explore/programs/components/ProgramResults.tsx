"use client";

import { memo, type RefObject } from "react";
import { Search } from "lucide-react";
import type { Program } from "@/lib/explore/programs";
import ProgramCard from "./ProgramCard";

interface ProgramResultsProps {
  programs: Program[];
  isLoading: boolean;
  viewMode: "grid" | "list";
  sentinelRef: RefObject<HTMLDivElement>;
  /** #664 — viewer's ACTIVE org memberships as { orgId: orgName }. */
  viewerOrgs?: Record<string, string>;
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-muted/35 py-16 text-center">
      <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-muted flex items-center justify-center">
        <Search className="w-10 h-10 text-muted-foreground/70" />
      </div>
      <h3 className="text-xl font-semibold text-foreground mb-2">
        No programs found
      </h3>
      <p className="text-muted-foreground max-w-md mx-auto">
        Try adjusting your filters or search terms to discover more programs
      </p>
    </div>
  );
}

/**
 * Grid / list rendering of the all-programs section, plus the empty state,
 * the load-more spinner, and the sentinel `<div>` that the parent's
 * `useInfiniteScroll` observes for pagination.
 */
function ProgramResultsImpl({
  programs,
  isLoading,
  viewMode,
  sentinelRef,
  viewerOrgs,
}: ProgramResultsProps) {
  return (
    <>
      {viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {programs.map((item) => (
            <div key={item.id}>
              <ProgramCard
                program={item}
                variant="grid"
                viewerOrgs={viewerOrgs}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {programs.map((item) => (
            <div key={item.id}>
              <ProgramCard
                program={item}
                variant="list"
                viewerOrgs={viewerOrgs}
              />
            </div>
          ))}
        </div>
      )}

      {programs.length === 0 && !isLoading && <EmptyState />}

      {/* Sentinel for infinite scroll — observed by useInfiniteScroll. */}
      <div ref={sentinelRef} aria-hidden="true" />

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 border-3 border-muted border-t-primary rounded-full animate-spin" />
            <span className="text-muted-foreground">Loading programs...</span>
          </div>
        </div>
      )}
    </>
  );
}

const ProgramResults = memo(ProgramResultsImpl);
export default ProgramResults;
