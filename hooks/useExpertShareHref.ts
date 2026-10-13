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
 * Appends the expert's signed `?via=<token>` attribution query param from
 * their profile share link onto an individual offering URL so first-time buyer
 * purchases through shared offering links record own-link attribution.
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
  if (!via) return targetHref;

  const [basePath, existingQuery = ""] = targetHref.split("?");
  const targetParams = new URLSearchParams(existingQuery);
  if (!targetParams.has("via")) targetParams.set("via", via);
  const qs = targetParams.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}
