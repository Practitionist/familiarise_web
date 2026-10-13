"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { formatForViewer, type ViewerZone } from "@/lib/time/viewer-zone";

const backupInterestEntrySchema = z.object({
  id: z.string(),
  status: z.string(),
  windowStart: z.string(),
  windowEnd: z.string(),
  planKind: z.string().nullable().optional(),
  planId: z.string().nullable().optional(),
  consultantProfileId: z.string(),
  consultantName: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  checkoutHref: z.string().nullable().optional(),
  consultantProfile: z
    .object({
      user: z.object({
        name: z.string().nullable().optional(),
      }),
    })
    .optional(),
});

export type WaitlistOfferEntry = z.infer<typeof backupInterestEntrySchema>;

const backupInterestResponseSchema = z.object({
  data: z.array(backupInterestEntrySchema).default([]),
});

export const CONSULTEE_WAITLIST_QUERY_KEY = ["backup-interest"] as const;

const FALLBACK_TIME_FORMAT = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

function formatSessionWindow(
  windowStart: string,
  windowEnd: string,
  viewerZone?: ViewerZone,
): string | null {
  const start = new Date(windowStart);
  const end = new Date(windowEnd);
  if (Number.isNaN(start.getTime())) return null;
  if (viewerZone) {
    const startLabel = formatForViewer(
      start,
      viewerZone,
      "EEE, d MMM · h:mm a",
    );
    const endLabel = Number.isNaN(end.getTime())
      ? null
      : formatForViewer(end, viewerZone, "h:mm a");
    return endLabel ? `${startLabel} – ${endLabel}` : startLabel;
  }
  return FALLBACK_TIME_FORMAT.format(start);
}

function buildBookHref(entry: WaitlistOfferEntry): string {
  if (entry.checkoutHref) {
    return entry.checkoutHref;
  }
  if (entry.planId && entry.planKind === "CONSULTATION") {
    const qs = new URLSearchParams({
      startsAt: entry.windowStart,
      endsAt: entry.windowEnd,
    });
    return `/checkout/plans/consultation/${entry.planId}?${qs.toString()}`;
  }
  return `/explore/experts/${entry.consultantProfileId}`;
}

function resolveExpertName(offer: WaitlistOfferEntry): string {
  return (
    offer.consultantProfile?.user.name ?? offer.consultantName ?? "your expert"
  );
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
      const res = await fetch("/api/scheduling/backup-interest");
      if (!res.ok) return [];
      const json = await res.json().catch(() => null);
      const parsed = backupInterestResponseSchema.safeParse(json);
      return parsed.success ? parsed.data.data : [];
    },
  });

  const withdrawMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(
        `/api/scheduling/backup-interest?id=${encodeURIComponent(id)}`,
        {
          method: "DELETE",
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          body?.error ?? "Could not update notification preference",
        );
      }
      return id;
    },
    onSuccess: async (id) => {
      onDeclined?.(id);
      await queryClient.invalidateQueries({
        queryKey: CONSULTEE_WAITLIST_QUERY_KEY,
      });
      toast({
        title: "Notification removed",
        description: "You won't be notified about this time.",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Couldn't update notification",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const nowMs = Date.now();
  const activeOffers = (entries ?? fetchedEntries ?? []).filter(
    (entry) =>
      entry.status === "NOTIFIED" &&
      new Date(entry.windowStart).getTime() > nowMs,
  );

  if (activeOffers.length === 0) return null;

  return (
    <div className="mb-4 space-y-2" data-testid="waitlist-offer-banners">
      {activeOffers.map((offer) => {
        const windowText = formatSessionWindow(
          offer.windowStart,
          offer.windowEnd,
          viewerZone,
        );
        const bookHref = buildBookHref(offer);
        const expertName = resolveExpertName(offer);

        return (
          <section
            key={offer.id}
            aria-label="Open session time alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950 shadow-sm"
          >
            <div className="flex items-start gap-3">
              <AlertCircle
                className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
                aria-hidden
              />
              <div>
                <p className="text-sm font-semibold">
                  {windowText
                    ? `A slot opened: ${windowText} with ${expertName}`
                    : `A slot opened with ${expertName}`}
                </p>
                <p className="text-xs text-amber-800">
                  A time you were waiting for just opened. First to book gets it
                  — the slot is not held.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" asChild>
                <Link href={bookHref}>Book now</Link>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={withdrawMutation.isPending}
                onClick={() => withdrawMutation.mutate(offer.id)}
              >
                Stop notifying me
              </Button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
