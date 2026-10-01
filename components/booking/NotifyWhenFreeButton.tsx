"use client";

import { useMutation } from "@tanstack/react-query";
import { BellRing } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

/** The refusal codes that mean "someone else holds this window" (#1778). */
export const HELD_BY_SOMEONE_ELSE = new Set(["SLOT_TAKEN", "LOCK_CONTENTION"]);

export interface BackupWindowRequest {
  consultantProfileId: string;
  windowStart: string;
  windowEnd: string;
  planKind: "CONSULTATION" | "SUBSCRIPTION";
  planId?: string | null;
}

/**
 * #1778 — "Notify me if this time opens". Notify-only: nothing is reserved,
 * so the copy says the first to book gets it.
 */
export function NotifyWhenFreeButton({
  window,
}: Readonly<{ window: BackupWindowRequest }>) {
  const { toast } = useToast();
  const register = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/scheduling/backup-interest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(window),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save that");
    },
    onSuccess: () =>
      toast({
        title: "We'll tell you the moment it frees",
        description: "Nothing is held for you — the first to book gets it.",
      }),
    onError: (error: Error) =>
      toast({
        title: "Not saved",
        description: error.message,
        variant: "destructive",
      }),
  });
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={register.isPending || register.isSuccess}
      onClick={() => register.mutate()}
    >
      <BellRing className="mr-1.5 h-4 w-4" />
      {register.isSuccess
        ? "You'll be notified"
        : "Notify me if this time opens"}
    </Button>
  );
}
