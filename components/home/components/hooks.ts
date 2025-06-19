import { useMemo } from "react";
import type { TConsultantProfile } from "@/types/consultant";
import type { ReviewWithProfiles } from "@/types/review";

export const useOptimizedReviews = (reviews: ReviewWithProfiles[]) => {
  return useMemo(() => {
    if (reviews.length >= 4) return reviews;
    return [...reviews, ...reviews, ...reviews, ...reviews];
  }, [reviews]);
};

export const useMarqueeGroups = () => {
  return useMemo(
    () =>
      Array.from({ length: 3 }, (_, i) => ({
        ltrId: `ltr-group-${i}`,
        rtlId: `rtl-group-${i}`,
      })),
    [],
  );
};

export interface FetchError extends Error {
  info?: any;
  status?: number;
}

export const consultantsFetcher = async (
  url: string,
): Promise<TConsultantProfile[]> => {
  const res = await fetch(url);
  if (!res.ok) {
    const error: FetchError = new Error(
      "An error occurred while fetching the data.",
    );
    try {
      error.info = await res.json();
    } catch {
      error.info = await res.text();
    }
    error.status = res.status;
    throw error;
  }
  const jsonData = await res.json();
  return jsonData.data as TConsultantProfile[];
};

export const reviewsFetcher = async (
  url: string,
): Promise<ReviewWithProfiles[]> => {
  const res = await fetch(url);
  if (!res.ok) {
    const error: FetchError = new Error(
      "An error occurred while fetching the data.",
    );
    try {
      error.info = await res.json();
    } catch {
      error.info = await res.text();
    }
    error.status = res.status;
    throw error;
  }
  const jsonData = await res.json();
  return jsonData.data as ReviewWithProfiles[];
};
