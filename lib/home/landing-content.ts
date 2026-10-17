import type { IConsultantCardData } from "@/types/consultant";

export interface HomeExpert extends IConsultantCardData {
  subscriptionPlans?: Array<
    NonNullable<IConsultantCardData["subscriptionPlans"]>[number] & {
      subscriptionContents: { id: string; title: string; order: number }[];
    }
  >;
}

/** Prefer authored curriculum, then a public offering, then an expert profile. */
export function selectHomeSpotlight(experts: HomeExpert[]) {
  const expert =
    experts.find((item) =>
      item.subscriptionPlans?.some((plan) =>
        plan.subscriptionContents.some((content) => content.title.trim()),
      ),
    ) ??
    experts.find((item) => item.subscriptionPlans?.length) ??
    experts[0];

  if (!expert) return null;

  const plan =
    expert.subscriptionPlans?.find((item) =>
      item.subscriptionContents.some((content) => content.title.trim()),
    ) ?? expert.subscriptionPlans?.[0];

  return {
    expert,
    plan,
    milestones: (plan?.subscriptionContents ?? [])
      .filter((content) => content.title.trim())
      .toSorted((a, b) => a.order - b.order)
      .slice(0, 3),
  };
}

export function nameInitials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => Array.from(part)[0])
      .join("")
      .toUpperCase() || "F"
  );
}

/** Marketing uses an intentionally uploaded display photo, not an OAuth avatar. */
export function homePortrait(expert: IConsultantCardData) {
  return expert.user.profileDisplayImage || undefined;
}
