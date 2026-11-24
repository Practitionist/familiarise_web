"use client";

import { memo, useState } from "react";
import Image from "next/image";
import { Briefcase, ChevronDown, ChevronUp } from "lucide-react";

import { fieldDetail } from "@/components/home/fields";

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

  // Only fields with verified experts, most experts first.
  const listed = domains
    .filter((domain) => domain.consultantCount > 0)
    .sort((x, y) => y.consultantCount - x.consultantCount);
  if (listed.length === 0) return null;

  const displayed = expanded ? listed : listed.slice(0, INITIAL_DISPLAY);
  const hasMore = listed.length > INITIAL_DISPLAY;

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {displayed.map((domain) => {
          const photo = fieldDetail(domain.name)?.photo;
          return (
            <button
              key={domain.id}
              type="button"
              onClick={() => onDomainSelect(domain.id)}
              className="group relative isolate flex h-36 flex-col justify-end overflow-hidden rounded-2xl bg-zinc-900 p-4 text-left text-white transition-shadow hover:shadow-elevation-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {photo ? (
                <Image
                  src={photo.src}
                  alt=""
                  fill
                  sizes="(min-width: 1280px) 20vw, (min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw"
                  className="-z-10 object-cover transition-transform duration-500 group-hover:scale-105"
                />
              ) : (
                <Briefcase
                  aria-hidden="true"
                  className="absolute right-4 top-4 h-5 w-5 text-zinc-500"
                />
              )}
              <div
                aria-hidden="true"
                className="absolute inset-0 -z-10 bg-gradient-to-t from-black/85 via-black/40 to-black/10"
              />
              <h3 className="font-semibold line-clamp-1">{domain.name}</h3>
              <p className="text-sm text-zinc-300">
                {domain.consultantCount}{" "}
                {domain.consultantCount === 1 ? "expert" : "experts"}
              </p>
            </button>
          );
        })}
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
