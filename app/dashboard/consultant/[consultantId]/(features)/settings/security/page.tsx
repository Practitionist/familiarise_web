"use client";

import { DashboardContent } from "@/components/dashboard/PageScaffold";
import { SecuritySection } from "../sections/SecuritySection";

/** /settings/security — links to the password and session surfaces (#1785 L-2). */
export default function SecuritySettingsPage() {
  return (
    <DashboardContent>
      <SecuritySection />
    </DashboardContent>
  );
}
