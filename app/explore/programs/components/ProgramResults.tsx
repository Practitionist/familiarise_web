"use client";

import { memo, type RefObject } from "react";
import { motion } from "framer-motion";
import { Search } from "lucide-react";
import type { Program } from "../utils";
import ProgramCard from "./ProgramCard";

interface ProgramResultsProps {
  programs: Program[];
  isLoading: boolean;
  viewMode: "grid" | "list";
  sentinelRef: RefObject<HTMLDivElement>;
}

function EmptyState() {
  return (
    <motion.div
      className="text-center py-16"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
    >
      <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-zinc-100 flex items-center justify-center">
        <Search className="w-10 h-10 text-zinc-400" />
      </div>
      <h3 className="text-xl font-semibold text-zinc-900 mb-2">
        No programs found
      </h3>
      <p className="text-zinc-500 max-w-md mx-auto">
        Try adjusting your filters or search terms to discover more programs
      </p>
    </motion.div>
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
}: ProgramResultsProps) {
  return (
    <>
      {viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {programs.map((item, index) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{
                duration: 0.4,
                delay: Math.min(index * 0.05, 0.6),
              }}
            >
              <ProgramCard program={item} variant="grid" />
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {programs.map((item, index) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{
                duration: 0.4,
                delay: Math.min(index * 0.05, 0.6),
              }}
            >
              <ProgramCard program={item} variant="list" />
            </motion.div>
          ))}
        </div>
      )}

      {programs.length === 0 && !isLoading && <EmptyState />}

      {/* Sentinel for infinite scroll — observed by useInfiniteScroll. */}
      <div ref={sentinelRef} aria-hidden="true" />

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 border-3 border-zinc-200 border-t-zinc-900 rounded-full animate-spin" />
            <span className="text-zinc-500">Loading programs...</span>
          </div>
        </div>
      )}
    </>
  );
}

const ProgramResults = memo(ProgramResultsImpl);
export default ProgramResults;
