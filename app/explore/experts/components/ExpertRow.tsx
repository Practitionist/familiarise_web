"use client";

import { memo } from "react";

import {
  HorizontalRow,
  HorizontalRowSkeleton,
} from "@/components/explore/HorizontalRow";
import ExpertMiniCard from "./ExpertMiniCard";
import type { IConsultantCardData } from "../utils";

/**
 * A thin wrapper over the shared `HorizontalRow` — the twin of
 * `programs/components/ProgramRow.tsx`. Those two were 89 and 91 lines of the
 * same component: scroll step 280 vs 380, card width `w-[260px]` vs
 * `w-[320px] md:w-[360px]`, gap `gap-4` vs `gap-5`, five skeletons vs four,
 * and character-for-character identical arrow-button class strings.
 *
 * All of that is now two props.
 */
function ExpertRowImpl({
  experts,
  badge,
  isLoading = false,
  heading,
}: {
  experts: IConsultantCardData[];
  isLoading?: boolean;
  /** Curation label shown on each card's badge. */
  badge?: "trending" | "new";
  heading?: string;
}) {
  if (isLoading) return <HorizontalRowSkeleton count={5} cardWidth="w-[248px]" />;
  if (experts.length === 0) return null;

  return (
    <HorizontalRow
      heading={heading}
      label={heading}
      cardWidth="w-[248px]"
    >
      {experts.map((expert) => (
        <ExpertMiniCard key={expert.id} expert={expert} badge={badge} />
      ))}
    </HorizontalRow>
  );
}

const ExpertRow = memo(ExpertRowImpl);
export default ExpertRow;
