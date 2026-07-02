"use client";

import { useRouter } from "next/navigation";
import { use, useEffect } from "react";
import { PersonalDashboardShellSkeleton } from "@/components/dashboard/PersonalDashboardShell";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function ConsulteePage({ params }: Readonly<PageProps>) {
  const resolvedParams = use(params);
  const consulteeId = resolvedParams.consulteeId;
  const router = useRouter();

  useEffect(() => {
    if (consulteeId) {
      // Use replace to avoid adding to browser history
      router.replace(`/dashboard/consultee/${consulteeId}/home`);
    }
  }, [consulteeId, router]);

  // Brief shell skeleton during the redirect — matches the layout chrome so
  // there's no flash between this and the mounted dashboard.
  return <PersonalDashboardShellSkeleton />;
}
