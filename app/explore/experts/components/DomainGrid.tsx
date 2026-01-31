"use client";

import { useState } from "react";
import { Briefcase, ChevronDown, ChevronUp } from "lucide-react";

interface DomainWithCount {
  id: string;
  name: string;
  consultantCount: number;
}

interface DomainGridProps {
  domains: DomainWithCount[];
  isLoading?: boolean;
  onDomainSelect: (domainId: string) => void;
}

const INITIAL_DISPLAY = 9;

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-zinc-200 p-5 animate-pulse">
      <div className="w-10 h-10 bg-zinc-200 rounded-lg mb-3" />
      <div className="h-5 bg-zinc-200 rounded w-3/4 mb-2" />
      <div className="h-4 bg-zinc-100 rounded w-1/2" />
    </div>
  );
}

export default function DomainGrid({
  domains,
  isLoading,
  onDomainSelect,
}: DomainGridProps) {
  const [expanded, setExpanded] = useState(false);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (domains.length === 0) return null;

  const displayed = expanded ? domains : domains.slice(0, INITIAL_DISPLAY);
  const hasMore = domains.length > INITIAL_DISPLAY;

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {displayed.map((domain) => (
          <button
            key={domain.id}
            onClick={() => onDomainSelect(domain.id)}
            className="group text-left rounded-xl border border-zinc-200 bg-white p-5 hover:border-zinc-300 hover:shadow-md transition-all duration-200"
          >
            <div className="w-10 h-10 rounded-lg bg-zinc-100 group-hover:bg-zinc-900 flex items-center justify-center mb-3 transition-colors">
              <Briefcase className="w-5 h-5 text-zinc-500 group-hover:text-white transition-colors" />
            </div>
            <h3 className="font-semibold text-zinc-900 text-sm mb-1 line-clamp-1">
              {domain.name}
            </h3>
            <p className="text-xs text-zinc-500">
              {domain.consultantCount}{" "}
              {domain.consultantCount === 1 ? "expert" : "experts"}
            </p>
          </button>
        ))}
      </div>

      {hasMore && (
        <div className="flex justify-center mt-6">
          <button
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-zinc-600 bg-zinc-100 rounded-lg hover:bg-zinc-200 transition-colors"
          >
            {expanded ? (
              <>
                Show Less <ChevronUp className="w-4 h-4" />
              </>
            ) : (
              <>
                View All Domains <ChevronDown className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
