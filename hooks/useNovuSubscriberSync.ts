"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";

/**
 * Auto-syncs the current user as a Novu subscriber.
 * Called once per dashboard session. Uses a long staleTime to avoid repeat calls.
 */
export function useNovuSubscriberSync() {
  const { data: session } = useSession();

  return useQuery({
    queryKey: ["novu-subscriber-sync", session?.user?.id],
    queryFn: async () => {
      const res = await fetch("/api/novu/subscriber", { method: "POST" });
      if (!res.ok) {
        throw new Error("Failed to sync Novu subscriber");
      }
      return res.json();
    },
    enabled: !!session?.user?.id && !!process.env.NEXT_PUBLIC_NOVU_APP_ID,
    staleTime: 30 * 60 * 1000, // 30 minutes
    gcTime: 60 * 60 * 1000, // 1 hour
    retry: 1,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
}
