"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

const responseSchema = z.object({
  consultantProfileId: z.string(),
  href: z.string().startsWith("/"),
});

/** The signed-in expert's own share link for their own page; otherwise the plain profile path. */
export function useExpertShareHref(consultantId: string): string {
  const plain = `/explore/experts/${consultantId}`;
  const { data } = useQuery({
    queryKey: ["expert-share-href", consultantId],
    queryFn: async () => {
      const res = await fetch("/api/referrals/expert-link");
      if (!res.ok) throw new Error("Failed to load the share link");
      return responseSchema.parse(await res.json());
    },
    staleTime: Infinity,
  });
  return data?.consultantProfileId === consultantId ? data.href : plain;
}
