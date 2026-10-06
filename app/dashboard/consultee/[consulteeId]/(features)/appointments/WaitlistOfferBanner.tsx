"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { formatForViewer, type ViewerZone } from "@/lib/time/viewer-zone";

const waitlistOfferEntrySchema = z.object({
  id: z.string(),
  status: z.string(),
  offerExpiresAt: z.string().nullable().optional(),
  windowStart: z.string().nullable().optional(),
  windowEnd: z.string().nullable().optional(),
  planKind: z.string().nullable().optional(),
  planId: z.string().nullable().optional(),
  webinarId: z.string().nullable().optional(),
  classId: z.string().nullable().optional(),
  consultantProfileId: z.string().nullable().optional(),
  consultantName: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  checkoutHref: z.string().nullable().optional(),
});

export type WaitlistOfferEntry = z.infer<typeof waitlistOfferEntrySchema>;

const waitlistResponseSchema = z.object({
  data: z.array(waitlistOfferEntrySchema).default([]),
});

export const CONSULTEE_WAITLIST_QUERY_KEY = ["consultee-waitlist"] as const;

const FALLBACK_TIME_FORMAT = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

function formatOfferDeadline(
  offerExpiresAt: string | null | undefined,
  viewerZone?: ViewerZone,
): string | null {
  if (!offerExpiresAt) return null;
  const parsed = new Date(offerExpiresAt);
  if (Number.isNaN(parsed.getTime())) return null;
  if (viewerZone) {
    return formatForViewer(parsed, viewerZone, "EEE, d MMM · h:mm a");
  }
  return FALLBACK_TIME_FORMAT.format(parsed);
}

function buildClaimHref(entry: WaitlistOfferEntry): string {
  if (entry.checkoutHref) {
    if (entry.checkoutHref.includes("waitlist=")) return entry.checkoutHref;
    const sep = entry.checkoutHref.includes("?") ? "&" : "?";
    return `${entry.checkoutHref}${sep}waitlist=${encodeURIComponent(entry.id)}`;
  }
  if (entry.classId) {
    return `/checkout/plans/class/${entry.classId}?waitlist=${encodeURIComponent(entry.id)}`;
  }
  if (entry.webinarId) {
    return `/checkout/plans/webinar/${entry.webinarId}?waitlist=${encodeURIComponent(entry.id)}`;
  }
  if (entry.planId && entry.planKind) {
    const kind = entry.planKind.toLowerCase();
    return `/checkout/plans/${kind}/${entry.planId}?waitlist=${encodeURIComponent(entry.id)}`;
  }
  if (entry.consultantProfileId) {
    return `/explore/experts/${entry.consultantProfileId}?waitlist=${encodeURIComponent(entry.id)}`;
  }
  return `/explore/experts?waitlist=${encodeURIComponent(entry.id)}`;
}

export function WaitlistOfferBanner({
  entries,
  viewerZone,
  onDeclined,
}: Readonly<{
  entries?: WaitlistOfferEntry[];
  viewerZone?: ViewerZone;
  onDeclined?: (id: string) => void;
}>) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: fetchedEntries } = useQuery<WaitlistOfferEntry[]>({
    queryKey: CONSULTEE_WAITLIST_QUERY_KEY,
    enabled: entries === undefined,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch("/api/waitlist");
      if (!res.ok) return [];
      const json = await res.json().catch(() => null);
      const parsed = waitlistResponseSchema.safeParse(json);
      return parsed.success ? parsed.data.data : [];
    },
  });

  const declineMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(
        `/api/waitlist/${encodeURIComponent(id)}/decline`,
        {
          method: "POST",
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Could not decline spot");
      }
      return id;
    },
    onSuccess: async (id) => {
      onDeclined?.(id);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: CONSULTEE_WAITLIST_QUERY_KEY,
        }),
        queryClient.invalidateQueries({
          queryKey: ["backup-interest"],
        }),
      ]);
      toast({
        title: "Spot declined",
        description: "We have released the offered spot.",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Couldn't decline spot",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const activeOffers = (entries ?? fetchedEntries ?? []).filter(
    (entry) => entry.status === "NOTIFIED",
  );

  if (activeOffers.length === 0) return null;

  return (
    <div className="mb-4 space-y-2" data-testid="waitlist-offer-banners">
      {activeOffers.map((offer) => {
        const deadlineText = formatOfferDeadline(
          offer.offerExpiresAt ?? offer.windowEnd,
          viewerZone,
        );
        const claimHref = buildClaimHref(offer);
        const label =
          offer.title ??
          (offer.consultantName
            ? `Session with ${offer.consultantName}`
            : "Waitlist spot");

        return (
          <div
            key={offer.id}
            role="region"
            aria-label="Waitlist spot offer"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950 shadow-sm"
          >
            <div className="flex items-start gap-3">
              <AlertCircle
                className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
                aria-hidden
              />
              <div>
                <p className="text-sm font-semibold">
                  {deadlineText
                    ? `Spot Available — Respond before ${deadlineText}`
                    : "Spot Available"}
                </p>
                <p className="text-xs text-amber-800">
                  A spot opened up for {label}. Claim your spot to complete
                  checkout, or decline so the next learner can take it.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" asChild>
                <Link href={claimHref}>Claim Spot &amp; Pay</Link>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={declineMutation.isPending}
                onClick={() => declineMutation.mutate(offer.id)}
              >
                Decline Spot
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
