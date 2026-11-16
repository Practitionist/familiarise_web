/** How a conduct removal's decision reads to the removed learner, and whether they may appeal it. */
export function removalOutcomeCopy(
  resolution: { reviewsRemoval?: boolean; isAppeal: boolean },
  outcome: string,
): { appealable: boolean; label: string | null; note: string | null } {
  if (!resolution.reviewsRemoval) {
    return { appealable: !resolution.isAppeal, label: null, note: null };
  }
  if (outcome === "OVERTURNED") {
    return {
      appealable: false,
      label: "Removal overturned",
      note: "Support found the removal was not justified. Your seat is not given back, but anything still unrefunded on it was refunded to where you paid before this decision was recorded, and the block on the event's calls is lifted.",
    };
  }
  return {
    appealable: !resolution.isAppeal,
    label: "Removal upheld",
    note: "Support found the removal was justified, so nothing is refunded automatically. You can appeal this decision, or reply if you think part of your seat should be refunded.",
  };
}
