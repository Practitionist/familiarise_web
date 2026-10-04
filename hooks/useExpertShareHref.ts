"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

const responseSchema = z.object({ href: z.string().startsWith("/") });

/** The expert's signed share link (own-link take rate); the plain profile path until it loads. */
export function useExpertShareHref(consultantId: string): string {
  const plain = `/explore/experts/${consultantId}`;
  const { data } = useQuery({
    queryKey: ["expert-share-href", consultantId],
    queryFn: async () => {
      const res = await fetch("/api/referrals/expert-link");
      if (!res.ok) throw new Error("Failed to load the share link");
      return responseSchema.parse(await res.json()).href;
    },
    staleTime: Infinity,
  });
  return data ?? plain;
}
