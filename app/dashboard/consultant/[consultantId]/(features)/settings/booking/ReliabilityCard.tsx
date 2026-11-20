"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  EXPERT_STRIKE_THRESHOLD,
  OWN_STRIKE_CAUSE_LABEL,
  ownStrikesSchema,
} from "@/lib/booking/expert-reliability-rules";
import { parseJsonResponse } from "@/lib/fetch-helpers";
import { useZonedFormat } from "@/lib/time/zoned-format";

const ownStrikesResponseSchema = z.object({ data: ownStrikesSchema });

/** The expert's own reliability record: read-only, and never shown on their public profile. */
export function ReliabilityCard({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const zoned = useZonedFormat();
  const record = useQuery({
    queryKey: ["consultant-own-strikes", consultantId] as const,
    queryFn: async () => {
      const res = await fetch(`/api/user/consultants/${consultantId}/strikes`, {
        cache: "no-store",
      });
      const body = await parseJsonResponse(
        res,
        ownStrikesResponseSchema,
        "Couldn't load your reliability record",
      );
      return body.data;
    },
    staleTime: 60_000,
    retry: false,
  });
  const data = record.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Your reliability</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Cancelling a confirmed booking, paid or free, or missing a session you
          host is recorded here. Only you and our team see it; it never appears
          on your public profile. We look into a record of{" "}
          {EXPERT_STRIKE_THRESHOLD} or more in {data?.windowDays ?? 90} days.
        </p>
        {record.isError && (
          <p className="text-muted-foreground">
            Couldn&apos;t load your reliability record.
          </p>
        )}
        {data && (
          <>
            <p className="font-medium text-foreground">
              {data.count === 0
                ? `Nothing recorded in the last ${data.windowDays} days.`
                : `${data.count} recorded in the last ${data.windowDays} days.`}
            </p>
            {data.recent.length > 0 && (
              <ul className="space-y-1">
                {data.recent.map((strike) => (
                  <li
                    key={strike.at}
                    className="flex flex-wrap justify-between gap-2"
                  >
                    <span>
                      {OWN_STRIKE_CAUSE_LABEL[strike.cause]}
                      {strike.planTitle && (
                        <span className="block text-xs text-muted-foreground">
                          {strike.planTitle}
                          {strike.sessionAt
                            ? ` · session on ${zoned(strike.sessionAt, "d MMM yyyy, h:mm a")}`
                            : ""}
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground">
                      {zoned(strike.at, "d MMM yyyy")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
