"use client";

import { memo, useState } from "react";
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
    <div className="rounded-xl border border-border p-5 animate-pulse">
      <div className="w-10 h-10 bg-muted rounded-lg mb-3" />
      <div className="h-5 bg-muted rounded w-3/4 mb-2" />
      <div className="h-4 bg-muted rounded w-1/2" />
    </div>
  );
}

function DomainGridImpl({
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
            className="group card-lift text-left rounded-2xl border border-border bg-card p-5 hover:border-foreground/25 hover:shadow-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-muted transition-colors duration-300 group-hover:border-transparent group-hover:bg-primary">
              <Briefcase className="h-5 w-5 text-muted-foreground transition-colors duration-300 group-hover:text-primary-foreground" />
            </div>
            <h3 className="mb-1 mt-3 line-clamp-1 text-sm font-semibold tracking-tight text-foreground">
              {domain.name}
            </h3>
            <p className="text-xs text-muted-foreground">
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
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-muted-foreground bg-muted rounded-lg hover:bg-muted/80 transition-colors"
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

const DomainGrid = memo(DomainGridImpl);
export default DomainGrid;
