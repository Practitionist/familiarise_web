"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

const mySeatsSchema = z.object({
  data: z.object({
    webinarPlanIds: z.array(z.string()),
    classPlanIds: z.array(z.string()),
  }),
});

export interface MyEventSeats {
  webinarPlanIds: ReadonlySet<string>;
  classPlanIds: ReadonlySet<string>;
}

const NO_SEATS: MyEventSeats = {
  webinarPlanIds: new Set(),
  classPlanIds: new Set(),
};

async function fetchMyEventSeats(): Promise<MyEventSeats> {
  const res = await fetch("/api/participants/event-seats", {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`event-seats ${res.status}`);
  const { data } = mySeatsSchema.parse(await res.json());
  return {
    webinarPlanIds: new Set(data.webinarPlanIds),
    classPlanIds: new Set(data.classPlanIds),
  };
}

/**
 * The webinar and class plans the signed-in viewer holds a seat on. The public
 * plan lists carry a seat count and never who holds the seats, so "am I
 * registered" is answered here, for this viewer only.
 */
export function useMyEventSeats(userId: string | null | undefined) {
  const { data } = useQuery({
    queryKey: ["my-event-seats", userId],
    queryFn: fetchMyEventSeats,
    enabled: !!userId,
    staleTime: 60 * 1000,
  });
  return data ?? NO_SEATS;
}
