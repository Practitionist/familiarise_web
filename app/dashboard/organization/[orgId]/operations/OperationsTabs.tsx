"use client";

import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { UrlTabs, type UrlTab } from "@/components/dashboard/UrlTabs";

import { WaitlistPanel } from "./WaitlistPanel";
import { TrialsPanel } from "./TrialsPanel";
import { DocumentsPanel } from "./DocumentsPanel";
import { RecordingsPanel } from "./RecordingsPanel";

export function OperationsTabs({ orgId }: { orgId: string }) {
  const tabs: UrlTab[] = [
    { value: "waitlist", label: "Waitlist", content: <WaitlistPanel orgId={orgId} /> },
    { value: "trials", label: "Trials", content: <TrialsPanel orgId={orgId} /> },
    { value: "documents", label: "Documents", content: <DocumentsPanel orgId={orgId} /> },
    { value: "recordings", label: "Recordings", content: <RecordingsPanel orgId={orgId} /> },
  ];

  return (
    <>
      <DashboardHeader
        title="Operations"
        subtitle="Booking-side activity across this organization"
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <UrlTabs tabs={tabs} />
      </div>
    </>
  );
}
