"use client";

import { memo, type RefObject } from "react";
import { motion } from "framer-motion";
import { Search } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
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

function Empty() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      <EmptyState
        icon={Search}
        title="No programs match those filters"
        description="Try widening a filter, or clear the search to see everything currently on offer."
      />
    </motion.div>
  );
}

/**
 * The load-more affordance.
 *
 * This was `<div className="w-8 h-8 border-3 border-muted border-t-primary" />`
 * — and `border-3` is **not in Tailwind's default width scale** (0/2/4/8), so
 * the class resolved to nothing and the "spinner" rendered as a bare circle
 * with one coloured arc. `border-2` is what it meant.
 */
function LoadMore() {
  return (
    <div
      className="flex items-center justify-center gap-3 py-10"
      role="status"
      aria-live="polite"
    >
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-brand motion-reduce:animate-none"
        aria-hidden="true"
      />
      <span className="text-sm text-muted-foreground">Loading more programs…</span>
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
      <div
        className={
          viewMode === "grid"
            ? "grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            : "flex flex-col gap-4"
        }
      >
        {programs.map((item, index) => (
          <motion.div
            key={item.id}
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-64px" }}
            transition={{
              duration: 0.35,
              delay: Math.min(index * 0.04, 0.4),
            }}
          >
            <ProgramCard
              program={item}
              variant={viewMode}
              viewerOrgs={viewerOrgs}
            />
          </motion.div>
        ))}
      </div>

      {programs.length === 0 && !isLoading && <Empty />}

      {/* Sentinel for infinite scroll — observed by useInfiniteScroll. */}
      <div ref={sentinelRef} aria-hidden="true" />

      {isLoading && <LoadMore />}
    </>
  );
}

const ProgramResults = memo(ProgramResultsImpl);
export default ProgramResults;
