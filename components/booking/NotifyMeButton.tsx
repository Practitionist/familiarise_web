"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { BellOff, BellRing } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

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
  const look = compact
    ? ({ size: "sm", className: undefined } as const)
    : ({ size: "default", className: "w-full" } as const);
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toggle = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/scheduling/event-waitlist", {
        method: waiting ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, eventId }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save that");
    },
    onSuccess: () => {
      toast(
        waiting
          ? { title: "You left the waitlist" }
          : {
              title: "We'll tell you the moment a seat opens",
              description:
                "Nothing is held for you. We tell everyone waiting at once, at any hour, and the first to pay gets the seat.",
            },
      );
      router.refresh();
    },
    onError: (error: Error) =>
      toast({
        title: "Not saved",
        description: error.message,
        variant: "destructive",
      }),
  });

  if (!signedIn) {
    const search = searchParams?.toString();
    const returnTo = `${pathname}${search ? `?${search}` : ""}`;
    return (
      <Button asChild variant="outline" {...look}>
        <Link href={`/auth/signin?callbackUrl=${encodeURIComponent(returnTo)}`}>
          <BellRing className="mr-1.5 h-4 w-4" />
          Sign in to be notified
        </Link>
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      {...look}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate()}
    >
      {waiting ? (
        <BellOff className="mr-1.5 h-4 w-4" />
      ) : (
        <BellRing className="mr-1.5 h-4 w-4" />
      )}
      {waiting ? "Leave the waitlist" : "Notify me when a seat opens"}
    </Button>
  );
}
