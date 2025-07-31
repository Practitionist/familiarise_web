"use client";

import { use } from "react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import SettingsTab from "./SettingsTab";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function SettingsPage({ params }: Readonly<PageProps>) {
  const { consulteeId } = use(params);

  return (
    <DashboardErrorBoundary>
      <SettingsTab consulteeId={consulteeId} />
    </DashboardErrorBoundary>
  );
}
