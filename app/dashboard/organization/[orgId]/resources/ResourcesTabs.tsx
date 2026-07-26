"use client";

import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { UrlTabs, type UrlTab } from "@/components/dashboard/UrlTabs";

import { DocumentsPanel } from "./DocumentsPanel";
import { RecordingsPanel } from "./RecordingsPanel";

export function ResourcesTabs({ orgId }: { orgId: string }) {
  const tabs: UrlTab[] = [
    {
      value: "documents",
      label: "Documents",
      content: <DocumentsPanel orgId={orgId} />,
    },
    {
      value: "recordings",
      label: "Recordings",
      content: <RecordingsPanel orgId={orgId} />,
    },
  ];

  return (
    <>
      <DashboardHeader
        title="Resources"
        subtitle="Documents and session recordings from across this organization"
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <UrlTabs tabs={tabs} />
      </div>
    </>
  );
}
