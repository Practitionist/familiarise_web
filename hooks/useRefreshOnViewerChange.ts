"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { useSession } from "@/lib/auth-client";

/**
 * Re-render the server component once when the signed-in viewer differs from
 * the one it rendered for (a sign-in or account switch in another tab). At most
 * one refresh per (server viewer, client viewer) pair, so a failing server
 * session read cannot loop.
 */
export function useRefreshOnViewerChange(viewerUserId: string | null): void {
  const { data, isPending } = useSession();
  const router = useRouter();
  const refreshedFor = useRef<string | null>(null);
  const clientUserId = data?.user?.id ?? null;
  useEffect(() => {
    if (isPending || clientUserId === viewerUserId) return;
    const pair = `${viewerUserId ?? ""}|${clientUserId ?? ""}`;
    if (refreshedFor.current === pair) return;
    refreshedFor.current = pair;
    router.refresh();
  }, [isPending, clientUserId, viewerUserId, router]);
}
