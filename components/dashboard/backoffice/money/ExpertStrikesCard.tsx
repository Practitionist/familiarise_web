"use client";

import { useQuery } from "@tanstack/react-query";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  EXPERT_STRIKE_THRESHOLD,
  type ExpertStrikeReviewRow,
} from "@/lib/booking/expert-reliability-rules";
import { useZonedFormat } from "@/lib/time/zoned-format";

/**
 * D10 — experts with reliability strikes (expert cancels of paid bookings,
 * consultant no-shows) in the last 90 days. Read-only: no money is taken.
 */
export function ExpertStrikesCard() {
  const zoned = useZonedFormat();
  const list = useQuery({
    queryKey: ["expert-strikes"] as const,
    queryFn: async () => {
      const res = await fetch("/api/admin/sessions/expert-strikes");
      if (!res.ok) throw new Error("Failed to load");
      return (await res.json()) as { items: ExpertStrikeReviewRow[] };
    },
    staleTime: 60_000,
  });
  const items = list.data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Expert reliability (90 days)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {list.isError && (
          <p className="text-muted-foreground">Couldn&apos;t load strikes.</p>
        )}
        {!list.isError && items.length === 0 && (
          <p className="text-muted-foreground">No strikes recorded.</p>
        )}
        {items.map((row) => (
          <div
            key={row.consultantProfileId}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <span>
              {row.name ?? row.consultantProfileId} · {row.strikes} strike
              {row.strikes === 1 ? "" : "s"}
              {row.strikes >= EXPERT_STRIKE_THRESHOLD ? " · needs review" : ""}
            </span>
            {row.lastStrikeAt && (
              <span className="text-muted-foreground">
                last {zoned(row.lastStrikeAt, "d MMM yyyy")}
              </span>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
