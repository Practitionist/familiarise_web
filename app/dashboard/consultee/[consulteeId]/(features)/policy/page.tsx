"use client";

import { use } from "react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import PolicyTab from "./PolicyTab";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function PolicyPage({ params }: Readonly<PageProps>) {
  const { consulteeId } = use(params);
  
  return (
    <DashboardErrorBoundary>
      <PolicyTab consulteeId={consulteeId} />
    </DashboardErrorBoundary>
  );
}
