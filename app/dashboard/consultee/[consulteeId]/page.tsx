"use client";

import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import { Skeleton } from "components/ui/skeleton";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function ConsulteePage({ params }: Readonly<PageProps>) {
  const resolvedParams = use(params);
  const consulteeId = resolvedParams.consulteeId;
  const router = useRouter();
  const [isRedirecting, setIsRedirecting] = useState(false);

  useEffect(() => {
    if (consulteeId) {
      setIsRedirecting(true);

      // Use replace to avoid adding to browser history
      router.replace(`/dashboard/consultee/${consulteeId}/home`);
    }
  }, [consulteeId, router]);

  // Show a brief loading state during redirect
  if (isRedirecting || !consulteeId) {
    return (
      <div className="bg-slate-50 min-h-screen flex flex-col">
        {/* Skeleton Nav - matching consultee nav structure */}
        <div className="p-4 sm:p-8 bg-white shadow-sm">
          <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
            <div className="flex flex-col sm:flex-row gap-2 sm:gap-4">
              {Array.from({ length: 7 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-24 sm:w-32 rounded-md" />
              ))}
            </div>
            <div className="flex items-center gap-3">
              <Skeleton className="hidden md:block h-5 w-36" />
              <Skeleton className="h-9 w-20" />
              <Skeleton className="h-10 w-10 rounded-full" />
            </div>
          </div>
        </div>

        {/* Skeleton Main Content */}
        <div className="flex-grow overflow-y-auto p-8">
          <div className="space-y-6">
            <Skeleton className="h-12 w-64" />
            <Skeleton className="h-40 w-full rounded-lg" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Skeleton className="h-32 rounded-lg" />
              <Skeleton className="h-32 rounded-lg" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
