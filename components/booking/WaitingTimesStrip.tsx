"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { formatForViewer } from "@/lib/time/viewer-zone";

type WaitingRow = {
  id: string;
  windowStart: string;
  consultantProfile: { user: { name: string | null } };
};

const KEY = ["backup-interest"];

/**
 * #1778 — the learner's "Waiting for N times" strip on Home: each held time
 * they asked to hear about, with Withdraw. Renders nothing when there is none.
 */
export function WaitingTimesStrip() {
  const viewer = useViewerZone();
  const queryClient = useQueryClient();
  const { data } = useQuery<WaitingRow[]>({
    queryKey: KEY,
    queryFn: async () => {
      const res = await fetch("/api/scheduling/backup-interest");
      if (!res.ok) return [];
      return ((await res.json()) as { data: WaitingRow[] }).data;
    },
    staleTime: 60_000,
  });
  const withdraw = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/scheduling/backup-interest?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
  if (!data || data.length === 0) return null;
  return (
    <section
      aria-label="Times you are waiting for"
      className="rounded-2xl border border-border bg-card p-4"
    >
      <p className="mb-2 text-sm font-medium">
        Waiting for {data.length} {data.length === 1 ? "time" : "times"}
      </p>
      <ul className="space-y-2">
        {data.map((row) => (
          <li
            key={row.id}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <span className="text-muted-foreground">
              {formatForViewer(
                new Date(row.windowStart),
                viewer,
                "EEE d MMM, h:mm a",
              )}{" "}
              with {row.consultantProfile.user.name ?? "your expert"}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={withdraw.isPending}
              onClick={() => withdraw.mutate(row.id)}
            >
              Withdraw
            </Button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        You&apos;ll be told the moment one frees — first to book gets it.
      </p>
    </section>
  );
}
