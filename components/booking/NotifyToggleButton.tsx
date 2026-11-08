"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { BellOff, BellRing } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

/** Throws the server's sentence for a refused request so the toast can show it. */
export async function assertOk(res: Response): Promise<void> {
  if (res.ok) return;
  const body: unknown = await res.json().catch(() => null);
  const message =
    body && typeof body === "object" && "error" in body
      ? body.error
      : undefined;
  throw new Error(
    typeof message === "string" ? message : "Could not save that",
  );
}

export interface NotifyToggleButtonProps {
  signedIn: boolean;
  /** The viewer already asked; the button now offers the opposite. */
  active: boolean;
  /** Stops a second press while `active` (no way to leave from here). */
  lockWhenActive?: boolean;
  compact?: boolean;
  labels: { join: string; leave: string; signIn: string };
  /** What the toast says after a join; a leave always reads `leaveTitle`. */
  joinToast: { title: string; description: string };
  leaveTitle: string;
  /** Sends the join (active=false) or leave (active=true) request; throws on refusal. */
  request: (leaving: boolean) => Promise<void>;
  onDone: (leaving: boolean) => void;
}

/**
 * The presentational Notify toggle shared by the appointment waitlist and the
 * 1:1 slot backup interest: signed-out link, join/leave states, pending state
 * and toast. Each wrapper supplies its own request.
 */
export function NotifyToggleButton({
  signedIn,
  active,
  lockWhenActive = false,
  compact = false,
  labels,
  joinToast,
  leaveTitle,
  request,
  onDone,
}: Readonly<NotifyToggleButtonProps>) {
  const look = compact
    ? ({ size: "sm", className: undefined } as const)
    : ({ size: "default", className: "w-full" } as const);
  const { toast } = useToast();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toggle = useMutation({
    mutationFn: () => request(active),
    onSuccess: () => {
      toast(active ? { title: leaveTitle } : joinToast);
      onDone(active);
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
          {labels.signIn}
        </Link>
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      {...look}
      disabled={toggle.isPending || (lockWhenActive && active)}
      onClick={() => toggle.mutate()}
    >
      {active && !lockWhenActive ? (
        <BellOff className="mr-1.5 h-4 w-4" />
      ) : (
        <BellRing className="mr-1.5 h-4 w-4" />
      )}
      {active ? labels.leave : labels.join}
    </Button>
  );
}
