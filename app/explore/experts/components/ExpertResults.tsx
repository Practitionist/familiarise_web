"use client";

import { memo, type RefObject } from "react";
import { motion } from "framer-motion";
import { Search } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import type { IConsultantCardData, IExpertsMetaData } from "../utils";
import ConsultantCard from "./ConsultantCard";

interface ExpertResultsProps {
  consultants: IConsultantCardData[];
  isLoading: boolean;
  isRefetching: boolean;
  isLoadingMore: boolean;
  metadata: IExpertsMetaData | null;
  /** When non-null, results are grouped by domain header. */
  groupByDomainId: string | null;
  sentinelRef: RefObject<HTMLDivElement>;
  onSelect?: (consultant: IConsultantCardData) => void;
}

/**
 * The result grid.
 *
 * Was a single column of 490px cards, which put 1.5 experts in a viewport and
 * made the page 9,056px long for a 14-expert directory. The card is now a card
 * (~150px), so this is a grid: 1-up on mobile, 2-up from `md`, 3-up from
 * `2xl`. At 3-up you see nine experts per screen instead of one and a half.
 *
 * Domain grouping is retained, but the group header is a single quiet rule
 * rather than the gradient bar + 2xl heading it was — with 14 results, a
 * 24px-bold heading per domain was louder than the results themselves.
 */
function ExpertResultsImpl({
  consultants,
  isLoading,
  isRefetching,
  isLoadingMore,
  metadata,
  groupByDomainId,
  sentinelRef,
  onSelect,
}: Readonly<ExpertResultsProps>) {
  const grouped = groupConsultantsByDomain(consultants);
  const showEmpty = consultants.length === 0 && !isLoading && !isRefetching;

  // Initial load: card-shaped placeholders, not full-width bars.
  if ((isLoading || isRefetching) && consultants.length === 0) {
    return (
      <div
        className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3"
        aria-label="Loading experts"
        aria-busy="true"
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <ResultCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  return (
    <div className="relative mt-8 min-h-[320px]">
      {/* Soft refetch veil — keep stale results visible, no spinner CLS. */}
      {isRefetching && consultants.length > 0 && (
        <div
          className="pointer-events-none absolute inset-0 z-10 rounded-card bg-background/50 backdrop-blur-[1px]"
          aria-hidden
        />
      )}

      {groupByDomainId ? (
        <div className="space-y-10">
          {metadata?.domains.map((domain) => {
            const rows = grouped[domain.id] || [];
            if (rows.length === 0) return null;
            return (
              <motion.section
                key={domain.id}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-64px" }}
                transition={{ duration: 0.3 }}
              >
                <div className="mb-4 flex items-baseline gap-3 border-b border-border-subtle pb-2">
                  <h3 className="font-display text-base font-semibold tracking-tight text-foreground">
                    {domain.name}
                  </h3>
                  <span className="tnum text-xs text-muted-foreground">
                    {rows.length} {rows.length === 1 ? "expert" : "experts"}
                  </span>
                </div>
                <ResultGrid>
                  {rows.map((consultant) => (
                    <ConsultantCard
                      key={consultant.id}
                      consultant={consultant}
                      onSelect={onSelect}
                    />
                  ))}
                </ResultGrid>
              </motion.section>
            );
          })}
        </div>
      ) : (
        <ResultGrid>
          {consultants.map((consultant, index) => (
            <motion.div
              key={consultant.id}
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-64px" }}
              transition={{ duration: 0.3, delay: Math.min(index * 0.03, 0.3) }}
              className="h-full"
            >
              <ConsultantCard
                consultant={consultant}
                onSelect={onSelect}
              />
            </motion.div>
          ))}
        </ResultGrid>
      )}

      {showEmpty && (
        <EmptyState
          icon={Search}
          title="No experts match those filters"
          description="Try clearing a filter or searching a different domain — there are plenty more mentors to meet."
        />
      )}

      {/* Sentinel for infinite scroll — observed by useInfiniteScroll. */}
      <div ref={sentinelRef} aria-hidden="true" />

      {isLoadingMore && (
        <div
          className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3"
          role="status"
          aria-live="polite"
        >
          <span className="sr-only">Loading more experts</span>
          {[1, 2, 3].map((i) => (
            <ResultCardSkeleton key={i} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The one grid definition. Previously there was no grid at all, so the columns
 * were a decision each caller had to make; three callers made it three ways.
 */
function ResultGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
      {children}
    </div>
  );
}

/** Matches the real card's silhouette: portrait + two lines + a rule. */
function ResultCardSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="rounded-card border border-border bg-card p-5 motion-reduce:animate-none"
    >
      <div className="flex gap-4">
        <div className="h-14 w-14 shrink-0 animate-pulse rounded-card bg-muted" />
        <div className="flex-1 space-y-2 pt-1">
          <div className="h-4 w-2/5 animate-pulse rounded bg-muted" />
          <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div className="mt-3 flex gap-1.5 border-t border-border-subtle pt-3">
        <div className="h-4 w-16 animate-pulse rounded-chip bg-muted" />
        <div className="h-4 w-20 animate-pulse rounded-chip bg-muted" />
      </div>
    </div>
  );
}

function groupConsultantsByDomain(
  consultants: IConsultantCardData[],
): Record<string, IConsultantCardData[]> {
  const out: Record<string, IConsultantCardData[]> = {};
  for (const c of consultants) {
    const key = c.domain?.id ?? "other";
    (out[key] ??= []).push(c);
  }
  return out;
}

const ExpertResults = memo(ExpertResultsImpl);
export default ExpertResults;
