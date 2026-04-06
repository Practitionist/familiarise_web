"use client";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import MessagesTab from "./MessagesTab";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function MessagesPage({ params: _params }: Readonly<PageProps>) {
  return (
    <DashboardErrorBoundary>
      <MessagesTab />
    </DashboardErrorBoundary>
  );
}
