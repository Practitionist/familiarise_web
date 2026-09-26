"use client";

import { DashboardContent } from "@/components/dashboard/PageScaffold";
import { ExperienceForm } from "./ExperienceForm";

/** /settings/experience — Public profile › Experience & education (#1527 §14). */
export default function ExperienceSettingsPage() {
  return (
    <DashboardContent>
      <ExperienceForm />
    </DashboardContent>
  );
}
