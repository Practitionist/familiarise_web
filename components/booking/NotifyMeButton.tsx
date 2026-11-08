"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

import { EVENT_WAITLIST_QUERY_KEY } from "@/lib/booking/interest/query-keys";

import { assertOk, NotifyToggleButton } from "./NotifyToggleButton";

export interface NotifyMeButtonProps {
  kind: "WEBINAR" | "CLASS";
  eventId: string;
  /** The server read the viewer's open row on this event's list. */
  waiting: boolean;
  signedIn: boolean;
  /** A small inline button for a batch card instead of a full-width one. */
  compact?: boolean;
}

/**
 * "Notify me" on a sold-out webinar or class. Notify-only: nothing is held, so
 * the copy says the first to pay gets the seat.
 */
export function NotifyMeButton({
  kind,
  eventId,
  waiting,
  signedIn,
  compact = false,
}: Readonly<NotifyMeButtonProps>) {
  const router = useRouter();
  const queryClient = useQueryClient();
  return (
    <NotifyToggleButton
      signedIn={signedIn}
      active={waiting}
      compact={compact}
      labels={{
        join: "Notify me when a seat opens",
        leave: "You're on the list · Leave",
        signIn: "Sign in to be notified",
      }}
      joinToast={{
        title: "We'll tell you the moment a seat opens",
        description:
          "Nothing is held for you. We tell everyone waiting at once, at any hour, and the first to pay gets the seat.",
      }}
      leaveTitle="You left the waitlist"
      request={async (leaving) => {
        const res = await fetch("/api/scheduling/event-waitlist", {
          method: leaving ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, eventId }),
        });
        await assertOk(res);
      }}
      onDone={() => {
        void queryClient.invalidateQueries({
          queryKey: EVENT_WAITLIST_QUERY_KEY,
        });
        router.refresh();
      }}
    />
  );
}
