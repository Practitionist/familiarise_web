"use client";

import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import { Skeleton } from "components/ui/skeleton";

export default function ConsultantDashboard({
  params,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
}>) {
  const resolvedParams = use(params);
  const consultantId = resolvedParams.consultantId;
  const router = useRouter();
  const [isRedirecting, setIsRedirecting] = useState(false);

  useEffect(() => {
    if (consultantId) {
      setIsRedirecting(true);
      
      // Use replace to avoid adding to browser history
      router.replace(`/dashboard/consultant/${consultantId}/home`);
    }
  }, [consultantId, router]);

  // Show a brief loading state during redirect
  if (isRedirecting || !consultantId) {
    return (
      <div className="flex flex-col space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full rounded-md" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-24 rounded-md" />
          <Skeleton className="h-24 rounded-md" />
        </div>
      </div>
    );
  }

  return null;
}
