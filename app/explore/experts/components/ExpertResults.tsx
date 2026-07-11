"use client";

import { motion } from "framer-motion";
import { Search } from "lucide-react";
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
}

function EmptyState() {
  return (
    <motion.div
      className="text-center py-16 rounded-2xl border border-dashed border-border bg-card"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
    >
      <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-muted flex items-center justify-center">
        <Search className="w-8 h-8 text-muted-foreground/70" />
      </div>
      <h3 className="text-xl font-semibold tracking-tight text-foreground mb-2">
        No experts found
      </h3>
      <p className="text-muted-foreground max-w-md mx-auto">
        Try adjusting your filters or search terms to discover more experts.
      </p>
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
}: ExpertResultsProps) {
  const grouped = groupConsultantsByDomain(consultants);
  const showEmpty = consultants.length === 0 && !isLoading && !isRefetching;

  return (
    <div className="mt-8 min-h-[400px] relative">
      {/* Loading overlay — sits on top of stale results to preserve scroll. */}
      {(isLoading || isRefetching) && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-2xl">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-muted border-t-foreground rounded-full animate-spin" />
            <p className="text-muted-foreground text-sm">Finding experts...</p>
          </div>
        </div>
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
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-1 h-8 bg-foreground rounded-full" />
                  <h3 className="text-2xl font-bold tracking-tight text-foreground">
                    {domain.name}
                  </h3>
                  <span className="px-3 py-1 bg-muted rounded-full text-sm text-muted-foreground">
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
              <ConsultantCard consultant={consultant} metadata={metadata} />
            </motion.div>
          ))}
        </div>
      )}

      {showEmpty && <EmptyState />}

      {/* Sentinel for infinite scroll — observed by useInfiniteScroll. */}
      <div ref={sentinelRef} aria-hidden="true" />

      {isLoadingMore && (
        <div className="flex justify-center py-8">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 border-3 border-muted border-t-foreground rounded-full animate-spin" />
            <span className="text-muted-foreground text-sm">Loading more...</span>
          </div>
        </div>
      )}
    </div>
  );
}

const ExpertResults = memo(ExpertResultsImpl);
export default ExpertResults;
