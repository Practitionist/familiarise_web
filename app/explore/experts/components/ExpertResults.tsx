"use client";

import { motion } from "framer-motion";
import { Search } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { memo, type RefObject } from "react";
import type { IConsultantCardData } from "@/types/consultant";
import { ConsultantCard } from "./ConsultantCard";
import {
  groupConsultantsByDomain,
  type IExpertsMetaData,
} from "../utils";

interface ExpertResultsProps {
  consultants: IConsultantCardData[];
  metadata: IExpertsMetaData | null;
  isLoading: boolean;
  isRefetching: boolean;
  isLoadingMore: boolean;
  /** When non-null, results are grouped by domain header. */
  groupByDomainId: string | null;
  sentinelRef: RefObject<HTMLDivElement>;
  onSelect?: (consultant: IConsultantCardData) => void;
}

/** Was the 6th hand-rolled empty state in scope. Now the shared primitive. */
function Empty() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      <EmptyState
        icon={Search}
        title="No experts match those filters"
        description="Try clearing a filter or searching a different domain — there are plenty more mentors to meet."
      />
    </motion.div>
  );
}

/**
 * The infinite-scrolling results region: stale-data overlay during refetch,
 * grouped or flat layout, empty state, load-more spinner, and a single
 * sentinel `<div>` at the bottom that the parent's `useInfiniteScroll`
 * observes.
 */
function ExpertResultsImpl({
  consultants,
  metadata,
  isLoading,
  isRefetching,
  isLoadingMore,
  groupByDomainId,
  sentinelRef,
  onSelect,
}: Readonly<ExpertResultsProps>) {
  const grouped = groupConsultantsByDomain(consultants);
  const showEmpty = consultants.length === 0 && !isLoading && !isRefetching;

  // Initial load: show card-grid anatomy instead of a spinner overlay.
  if ((isLoading || isRefetching) && consultants.length === 0) {
    return (
      <div className="mt-8 min-h-[400px] space-y-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-36 animate-pulse rounded-card border border-border bg-card"
          />
        ))}
      </div>
    );
  }

  return (
    <div className="mt-8 min-h-[400px] relative">
      {/* Soft refetch veil — keep stale results visible (no spinner CLS). */}
      {isRefetching && consultants.length > 0 && (
        <div
          className="pointer-events-none absolute inset-0 z-10 rounded-card bg-background/50 backdrop-blur-[1px]"
          aria-hidden
        />
      )}

      {groupByDomainId ? (
        <>
          {metadata?.domains.map((domain) => {
            const domainConsultants = grouped[domain.id] || [];
            if (domainConsultants.length === 0) return null;

            return (
              <motion.div
                key={domain.id}
                className="mb-12"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5 }}
              >
                <div className="mb-5 flex items-center gap-3">
                  <h3 className="font-display text-xl font-bold tracking-tight text-foreground">
                    {domain.name}
                  </h3>
                  <span className="tnum rounded-chip border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {domainConsultants.length} expert
                    {domainConsultants.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="space-y-6">
                  {domainConsultants.map((consultant) => (
                    <ConsultantCard
                      key={consultant.id}
                      consultant={consultant}
                      metadata={metadata}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              </motion.div>
            );
          })}
        </>
      ) : (
        <div className="space-y-6">
          {consultants.map((consultant, index) => (
            <motion.div
              key={consultant.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{
                duration: 0.4,
                delay: Math.min(index * 0.05, 0.6),
              }}
            >
              <ConsultantCard
                consultant={consultant}
                metadata={metadata}
                onSelect={onSelect}
              />
            </motion.div>
          ))}
        </div>
      )}

      {showEmpty && <Empty />}

      {/* Sentinel for infinite scroll — observed by useInfiniteScroll. */}
      <div ref={sentinelRef} aria-hidden="true" />

      {/* Load-more placeholders. These were the 4th skeleton idiom in scope —
          the listings had hand-rolled `animate-pulse` divs here, `loading.tsx`
          had another set, and the programs page used the <Skeleton> primitive
          with a different fill. All match the real card silhouette now. */}
      {isLoadingMore && (
        <div className="space-y-4 py-6" role="status" aria-live="polite">
          <span className="sr-only">Loading more experts</span>
          {[1, 2].map((i) => (
            <div
              key={i}
              aria-hidden="true"
              className="h-28 animate-pulse rounded-card border border-border bg-card motion-reduce:animate-none"
            />
          ))}
        </div>
      )}
    </div>
  );
}

const ExpertResults = memo(ExpertResultsImpl);
export default ExpertResults;
