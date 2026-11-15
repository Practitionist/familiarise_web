"use client";

import { Flag, Loader2 } from "lucide-react";
import { useState } from "react";
import { z } from "zod";

import { useToast } from "@/hooks/use-toast";
import { cn } from "@/utils/tailwind";

const linkResponse = z.object({ href: z.string().startsWith("/") });

interface ReportConcernButtonProps {
  /** A GET route answering `{ href }`: the support page for this booking. */
  endpoint: string;
  className?: string;
}

/**
 * Opens support for this booking in a new tab, so a live session is not left.
 * The safety flow there reaches a person; staff pick who the concern is about.
 */
export function ReportConcernButton({
  endpoint,
  className,
}: Readonly<ReportConcernButtonProps>) {
  const { toast } = useToast();
  const [pending, setPending] = useState(false);

  const open = async () => {
    if (pending) return;
    setPending(true);
    try {
      const response = await fetch(endpoint);
      const parsed = linkResponse.safeParse(
        await response.json().catch(() => null),
      );
      if (!response.ok || !parsed.success) throw new Error("no link");
      window.open(parsed.data.href, "_blank", "noopener,noreferrer");
    } catch {
      toast({
        title: "Could not open support",
        description: "Please try again, or use Get help from your dashboard.",
        variant: "destructive",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void open()}
      disabled={pending}
      className={cn(
        "flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors disabled:opacity-50",
        className,
      )}
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <Flag className="h-4 w-4" aria-hidden />
      )}
      Report a concern
    </button>
  );
}
