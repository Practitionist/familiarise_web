"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { CONSULTEE_BACKUP_INTEREST_QUERY_KEY } from "@/lib/booking/interest/query-keys";

import { assertOk, NotifyToggleButton } from "./NotifyToggleButton";

/** The refusal codes that mean "someone else holds this window". */
export const HELD_BY_SOMEONE_ELSE = new Set(["SLOT_TAKEN", "LOCK_CONTENTION"]);

export interface BackupWindowRequest {
  consultantProfileId: string;
  windowStart: string;
  windowEnd: string;
  planKind: "CONSULTATION" | "SUBSCRIPTION";
  planId?: string | null;
}

/**
 * "Notify me if this time opens" for a 1:1 window. Notify-only: nothing is
 * reserved, so the copy says the first to book gets it.
 */
export function NotifyWhenFreeButton({
  window,
}: Readonly<{ window: BackupWindowRequest }>) {
  const queryClient = useQueryClient();
  const [registered, setRegistered] = useState(false);
  return (
    <NotifyToggleButton
      signedIn
      compact
      active={registered}
      lockWhenActive
      labels={{
        join: "Notify me if this time opens",
        leave: "You'll be notified",
        signIn: "Sign in to be notified",
      }}
      joinToast={{
        title: "We'll tell you the moment it frees",
        description: "Nothing is held for you — the first to book gets it.",
      }}
      leaveTitle="Notification removed"
      request={async () => {
        const res = await fetch("/api/scheduling/backup-interest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(window),
        });
        await assertOk(res);
      }}
      onDone={() => {
        setRegistered(true);
        void queryClient.invalidateQueries({
          queryKey: CONSULTEE_BACKUP_INTEREST_QUERY_KEY,
        });
      }}
    />
  );
}
