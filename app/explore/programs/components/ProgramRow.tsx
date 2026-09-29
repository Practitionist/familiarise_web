"use client";

import { memo } from "react";

import {
  HorizontalRow,
  HorizontalRowSkeleton,
} from "@/components/explore/HorizontalRow";
import ProgramCard from "./ProgramCard";
import type { Program } from "@/lib/explore/programs";

/** A thin wrapper over the shared `HorizontalRow` — see ExpertRow.tsx. */
function ProgramRowImpl({
  programs,
  isLoading = false,
  heading,
  badge,
  viewerOrgs,
}: {
  programs: Program[];
  isLoading?: boolean;
  heading?: string;
  badge?: "featured" | "trending" | "new";
  /** #664 — viewer's ACTIVE org memberships as { orgId: orgName }. */
  viewerOrgs?: Record<string, string>;
}) {
  if (isLoading) return <HorizontalRowSkeleton count={4} cardWidth="w-[300px]" />;
  if (programs.length === 0) return null;

  return (
    <HorizontalRow heading={heading} label={heading}>
      {programs.map((program) => (
        <ProgramCard
          key={program.id}
          program={program}
          variant="carousel"
          badge={badge}
          viewerOrgs={viewerOrgs}
        />
      ))}
    </HorizontalRow>
  );
}

const ProgramRow = memo(ProgramRowImpl);
export default ProgramRow;
