"use client";

import { use } from "react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import LearningProfileForm from "./LearningProfileForm";

/** Settings › Learning profile — the learner fields that used to be all of Settings. */
export default function LearningProfilePage({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = use(params);
  return (
    <DashboardErrorBoundary>
      <LearningProfileForm consulteeId={consulteeId} />
    </DashboardErrorBoundary>
  );
}
