"use client";

import { memo, useState } from "react";
import { Flame, Sparkles } from "lucide-react";

import { SegmentedControl } from "@/components/ui/segmented-control";
import ExpertRow from "./ExpertRow";
import DomainGrid from "./DomainGrid";
import type { IConsultantCardData } from "@/types/consultant";
import type { IExpertsMetaData } from "../utils";
import type { SortOption } from "./SearchBar";

interface StaticTopRowsProps {
  metadata: IExpertsMetaData | null;
  trendingExperts: IConsultantCardData[];
  newestExperts: IConsultantCardData[];
  onSeeAllSort: (sort: SortOption) => void;
  onDomainSelect: (domainId: string) => void;
}

/**
 * Curated rows above the results.
 *
 * ── Why one rail, not two ───────────────────────────────────────────────────
 * This used to stack "Trending Experts" and "Newly Joined" as two separate
 * horizontal rails, each 5–8 mini-cards wide, each with a heading and a "See
 * all". Both datasets were already fetched and both were the same kind of
 * thing, so the visitor scrolled past ~700px of near-identical cards to reach
 * a 14-expert directory — a page that measured 9,056px.
 *
 * They are now ONE rail with a switch. Both datasets are already in memory, so
 * the switch costs nothing, and the two orderings are genuinely the same
 * decision ("who should I look at?") expressed as a choice rather than as
 * page structure. The default stays Trending, which is what the two stacked
 * rails led with.
 *
 * The section margins dropped from `mb-14` (56px) to `mb-10`, because four
 * stacked 56px gaps were a large part of the vertical cost.
 */
function StaticTopRowsImpl({
  metadata,
  trendingExperts,
  newestExperts,
  onSeeAllSort,
  onDomainSelect,
}: StaticTopRowsProps) {
  const [rail, setRail] = useState<"trending" | "new">("trending");

  return (
    <>
      <section className="mb-10">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">
            {rail === "trending" ? "Trending experts" : "Newly joined"}
          </h2>
          <div className="flex items-center gap-2">
            <SegmentedControl
              size="sm"
              label="Curated expert list"
              value={rail}
              onChange={setRail}
              options={[
                {
                  value: "trending",
                  label: (
                    <>
                      <Flame className="h-3.5 w-3.5" aria-hidden="true" />
                      Trending
                    </>
                  ),
                },
                {
                  value: "new",
                  label: (
                    <>
                      <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                      New
                    </>
                  ),
                },
              ]}
            />
            <button
              type="button"
              onClick={() => onSeeAllSort(rail === "trending" ? "trending" : "newest")}
              className="shrink-0 text-sm font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              See all
            </button>
          </div>
        </div>

        <ExpertRow
          experts={rail === "trending" ? trendingExperts : newestExperts}
          badge={rail === "trending" ? "trending" : "new"}
          isLoading={false}
        />
      </section>

      {/* Browse by Domain. The nav's "Browse by domain" item deep-links to
          #domains; scroll-mt clears the fixed navbar so the heading isn't
          hidden under it on landing. The grid renders its own heading, so
          there is deliberately no <SectionHeader> wrapping it — that pairing
          shipped two h2s one line apart. */}
      {metadata?.consultantMetadata?.consultantsByDomain && (
        <div
          id="domains"
          className="mb-10 scroll-mt-[calc(var(--header-height,5rem)+1rem)]"
        >
          <DomainGrid
            // The metadata rows carry `consultantCount`; the shared grid takes
            // a generic `count`, which is what lets one component serve both
            // the experts and programs surfaces.
            domains={metadata.consultantMetadata.consultantsByDomain.map((d) => ({
              id: d.id,
              name: d.name,
              count: d.consultantCount,
            }))}
            isLoading={false}
            onDomainSelect={onDomainSelect}
          />
        </div>
      )}
    </>
  );
}

const StaticTopRows = memo(StaticTopRowsImpl);
export default StaticTopRows;
