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

/**
 * Appends the expert's signed `?via=<token>` or `?ref=<code>` attribution
 * query param from their profile share link onto an individual offering URL so
 * shared offering links qualify for the 10% own-link platform fee.
 */
export function appendExpertShareAttribution(
  targetHref: string,
  expertShareHref?: string | null,
): string {
  if (!expertShareHref) return targetHref;
  const qIndex = expertShareHref.indexOf("?");
  if (qIndex === -1) return targetHref;
  const sourceParams = new URLSearchParams(expertShareHref.slice(qIndex + 1));
  const via = sourceParams.get("via");
  const ref = sourceParams.get("ref");
  if (!via && !ref) return targetHref;

  const [basePath, existingQuery = ""] = targetHref.split("?");
  const targetParams = new URLSearchParams(existingQuery);
  if (via && !targetParams.has("via")) targetParams.set("via", via);
  if (ref && !targetParams.has("ref")) targetParams.set("ref", ref);
  const qs = targetParams.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}
